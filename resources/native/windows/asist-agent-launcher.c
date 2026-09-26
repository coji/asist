#define WIN32_LEAN_AND_MEAN
// PROC_THREAD_ATTRIBUTE_JOB_LIST exists from Windows 10.
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/*
 * Starts an agent CLI inside a job object, so that the CLI and every process it starts end together.
 *
 *   asist-agent-launcher --version
 *   asist-agent-launcher --run <token> <parent-pid> <program.exe> [arguments...]
 *   asist-agent-launcher --inspect <token>
 *   asist-agent-launcher --stop <token>
 *
 * --run creates the job Local\asist-agent-<token>, then waits for the line "start" on its standard input
 * before it creates the program inside the job; the rest of the input is the program's. So the program
 * never writes before ASIST has saved the job, and never runs outside the job, and neither does anything
 * it starts. When the program exits, the launcher stops whatever it left running and waits until the job
 * is empty, so its own exit means that every descendant is gone; it then exits with the program's exit
 * code. When the parent process (ASIST) ends first, the launcher empties the job and exits. If the
 * launcher itself is killed, the job kills everything in it when its last handle closes.
 *
 * --inspect prints "gone" when no job has the token, or the number of processes in it. --stop stops every
 * process in the job and returns once it is empty; the --run that owns the job then exits as well, and a
 * --run that has not created the program yet never does.
 *
 * Only an .exe is started. CreateProcess runs a .cmd or .bat through cmd.exe, which reads the quotes and
 * parentheses in the arguments ASIST passes as its own syntax.
 */

#define LAUNCHER_VERSION "2"
#define EXIT_STOPPED 130

static int fail(const char *what)
{
    DWORD error = GetLastError();
    fprintf(stderr, "asist-agent-launcher: %s failed with error %lu\n", what, error);
    return 1;
}

static int is_exe(const wchar_t *program)
{
    size_t length = wcslen(program);
    return length > 4 && _wcsicmp(program + length - 4, L".exe") == 0;
}

/**
 * The name of the job or the stop event of a token. A token is ASIST's random UUID; anything else is
 * refused, so that a token can never name an object outside the launcher's own names.
 */
static int object_name(const wchar_t *kind, const wchar_t *token, wchar_t *name, size_t capacity)
{
    size_t length = wcslen(token);
    if (length == 0 || length > 64 || wcsspn(token, L"0123456789abcdefABCDEF-") != length) {
        fprintf(stderr, "asist-agent-launcher: %ls is not a token\n", token);
        return 1;
    }
    swprintf(name, capacity, L"Local\\asist-agent-%ls%ls", kind, token);
    return 0;
}

/**
 * Appends arg to out quoted so that CommandLineToArgvW and the C runtime read it back unchanged, and
 * returns the end. A run of backslashes is doubled only before a quote, where the parser halves it.
 */
static wchar_t *append_quoted(wchar_t *out, const wchar_t *arg)
{
    if (*arg != L'\0' && wcspbrk(arg, L" \t\n\v\"") == NULL) {
        size_t length = wcslen(arg);
        wmemcpy(out, arg, length);
        return out + length;
    }
    *out++ = L'"';
    for (const wchar_t *p = arg;; p++) {
        size_t backslashes = 0;
        while (*p == L'\\') {
            p++;
            backslashes++;
        }
        if (*p == L'\0') {
            for (size_t i = 0; i < backslashes * 2; i++) *out++ = L'\\';
            break;
        }
        if (*p == L'"') {
            for (size_t i = 0; i < backslashes * 2 + 1; i++) *out++ = L'\\';
        } else {
            for (size_t i = 0; i < backslashes; i++) *out++ = L'\\';
        }
        *out++ = *p;
    }
    *out++ = L'"';
    return out;
}

/** The command line of argv[first..argc-1]. Quoting at most doubles an argument, plus its quotes and a space. */
static wchar_t *command_line(int argc, wchar_t **argv, int first)
{
    size_t capacity = 1;
    for (int i = first; i < argc; i++) capacity += wcslen(argv[i]) * 2 + 3;
    wchar_t *line = malloc(capacity * sizeof(wchar_t));
    if (line == NULL) return NULL;
    wchar_t *end = line;
    for (int i = first; i < argc; i++) {
        if (i > first) *end++ = L' ';
        end = append_quoted(end, argv[i]);
    }
    *end = L'\0';
    return line;
}

static int active_processes(HANDLE job, DWORD *count)
{
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof accounting, NULL)) {
        return fail("QueryInformationJobObject");
    }
    *count = accounting.ActiveProcesses;
    return 0;
}

/**
 * Stops what is left in the job and returns once it has no process. The count is read again every 25 ms,
 * because Windows does not guarantee the delivery of the message a completion port would get.
 */
static int empty_job(HANDLE job)
{
    for (;;) {
        DWORD count;
        if (active_processes(job, &count) != 0) return 1;
        if (count == 0) return 0;
        if (!TerminateJobObject(job, EXIT_STOPPED)) return fail("TerminateJobObject");
        Sleep(25);
    }
}

/**
 * Reads the first line of standard input one byte at a time, so that nothing after it is taken from the
 * program that inherits the input, and returns whether it is "start". An end of input before it, which is
 * what a parent that ended leaves, returns false.
 */
static int read_start(void)
{
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    char line[8];
    size_t length = 0;
    for (;;) {
        char byte;
        DWORD read = 0;
        if (!ReadFile(input, &byte, 1, &read, NULL) || read == 0) return 0;
        if (byte == '\n') break;
        if (length == sizeof line) return 0;
        line[length++] = byte;
    }
    if (length > 0 && line[length - 1] == '\r') length--;
    return length == 5 && memcmp(line, "start", 5) == 0;
}

static int run(int argc, wchar_t **argv)
{
    wchar_t name[128];
    wchar_t stop_name[128];
    if (object_name(L"", argv[2], name, sizeof name / sizeof name[0]) != 0) return 1;
    if (object_name(L"stop-", argv[2], stop_name, sizeof stop_name / sizeof stop_name[0]) != 0) return 1;
    wchar_t *end = NULL;
    unsigned long parent_pid = wcstoul(argv[3], &end, 10);
    if (end == argv[3] || *end != L'\0' || parent_pid == 0) {
        fprintf(stderr, "asist-agent-launcher: %ls is not a process id\n", argv[3]);
        return 1;
    }
    if (!is_exe(argv[4])) {
        fprintf(stderr, "asist-agent-launcher: %ls is not an .exe\n", argv[4]);
        return 1;
    }

    // The parent is opened before anything starts, so its exit cannot be missed, and a parent that has
    // already gone ends the launcher here.
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parent_pid);
    if (parent == NULL) return fail("OpenProcess");

    HANDLE job = CreateJobObjectW(NULL, name);
    if (job == NULL) return fail("CreateJobObject");
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        fprintf(stderr, "asist-agent-launcher: a job named %ls already exists\n", name);
        return 1;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    ZeroMemory(&limits, sizeof limits);
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) {
        return fail("SetInformationJobObject");
    }
    // --stop sets this event before it empties the job. An empty job gives it nothing to stop, so a stop
    // that comes before the program exists is kept here, and the program is created suspended and started
    // only once the event is seen unset.
    HANDLE stopped = CreateEventW(NULL, TRUE, FALSE, stop_name);
    if (stopped == NULL) return fail("CreateEvent");

    if (!read_start()) return EXIT_STOPPED;

    SIZE_T size = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &size);
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = malloc(size);
    wchar_t *line = command_line(argc, argv, 4);
    if (attributes == NULL || line == NULL) {
        fprintf(stderr, "asist-agent-launcher: out of memory\n");
        return 1;
    }
    if (!InitializeProcThreadAttributeList(attributes, 1, 0, &size)) return fail("InitializeProcThreadAttributeList");
    if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof job, NULL, NULL)) {
        return fail("UpdateProcThreadAttribute");
    }

    // The standard handles came from ASIST as inheritable pipes, so the program writes straight into them.
    STARTUPINFOEXW startup;
    ZeroMemory(&startup, sizeof startup);
    startup.StartupInfo.cb = sizeof startup;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    startup.lpAttributeList = attributes;

    // With the program as the application name, CreateProcess neither searches for it nor appends .exe.
    PROCESS_INFORMATION child;
    if (!CreateProcessW(argv[4], line, NULL, NULL, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, NULL, NULL,
                        &startup.StartupInfo, &child)) {
        return fail("CreateProcess");
    }
    DeleteProcThreadAttributeList(attributes);
    free(attributes);
    free(line);
    if (WaitForSingleObject(stopped, 0) == WAIT_OBJECT_0) {
        if (empty_job(job) != 0) return 1;
        return EXIT_STOPPED;
    }
    // A stop after the check terminates the suspended program with the job, and the resume then fails
    // on a thread that is gone, which is harmless.
    ResumeThread(child.hThread);
    CloseHandle(child.hThread);

    HANDLE waits[2];
    waits[0] = child.hProcess;
    waits[1] = parent;
    DWORD woke = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
    if (woke == WAIT_OBJECT_0 + 1) {
        if (empty_job(job) != 0) return 1;
        return EXIT_STOPPED;
    }
    if (woke != WAIT_OBJECT_0) return fail("WaitForMultipleObjects");
    DWORD exit_code;
    if (!GetExitCodeProcess(child.hProcess, &exit_code)) return fail("GetExitCodeProcess");
    if (empty_job(job) != 0) return 1;
    return (int)exit_code;
}

/** --inspect and --stop, which reach the job of a --run through its name. */
static int reach(const wchar_t *token, int stop)
{
    wchar_t name[128];
    wchar_t stop_name[128];
    if (object_name(L"", token, name, sizeof name / sizeof name[0]) != 0) return 1;
    if (object_name(L"stop-", token, stop_name, sizeof stop_name / sizeof stop_name[0]) != 0) return 1;
    if (stop) {
        HANDLE stopped = OpenEventW(EVENT_MODIFY_STATE, FALSE, stop_name);
        if (stopped != NULL && !SetEvent(stopped)) return fail("SetEvent");
    }
    HANDLE job = OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, FALSE, name);
    if (job == NULL) {
        if (GetLastError() != ERROR_FILE_NOT_FOUND) return fail("OpenJobObject");
        printf("gone\n");
        return 0;
    }
    if (stop) {
        if (empty_job(job) != 0) return 1;
        printf("stopped\n");
        return 0;
    }
    DWORD count;
    if (active_processes(job, &count) != 0) return 1;
    printf("%lu\n", count);
    return 0;
}

int wmain(int argc, wchar_t **argv)
{
    if (argc == 2 && wcscmp(argv[1], L"--version") == 0) {
        printf("asist-agent-launcher %s\n", LAUNCHER_VERSION);
        return 0;
    }
    if (argc >= 5 && wcscmp(argv[1], L"--run") == 0) return run(argc, argv);
    if (argc == 3 && wcscmp(argv[1], L"--inspect") == 0) return reach(argv[2], 0);
    if (argc == 3 && wcscmp(argv[1], L"--stop") == 0) return reach(argv[2], 1);
    fprintf(stderr,
            "usage: asist-agent-launcher --version | --run <token> <parent-pid> <program.exe> [arguments...] | "
            "--inspect <token> | --stop <token>\n");
    return 1;
}
