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
 *   asist-agent-launcher <program.exe> [arguments...]
 *
 * The program is created inside the job, so neither it nor any child it creates is ever outside it. When
 * the program exits, the launcher stops whatever it left running and waits until the job is empty, so
 * the launcher's own exit means that every descendant is gone; it then exits with the program's exit
 * code. If the launcher itself is killed, the job kills everything in it when its last handle closes.
 *
 * Only an .exe is started. CreateProcess runs a .cmd or .bat through cmd.exe, which reads the quotes and
 * parentheses in the arguments ASIST passes as its own syntax.
 */

#define LAUNCHER_VERSION "1"

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

/**
 * Stops what is left in the job and returns once it has no process. The completion port wakes the wait
 * when the job reports that none is active, and the count is read again each time, because Windows does
 * not guarantee the delivery of a job's messages.
 */
static int empty_job(HANDLE job, HANDLE port)
{
    for (;;) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof accounting, NULL)) {
            return fail("QueryInformationJobObject");
        }
        if (accounting.ActiveProcesses == 0) return 0;
        if (!TerminateJobObject(job, 1)) return fail("TerminateJobObject");
        DWORD message;
        ULONG_PTR key;
        LPOVERLAPPED overlapped = NULL;
        if (!GetQueuedCompletionStatus(port, &message, &key, &overlapped, 100) && overlapped == NULL &&
            GetLastError() != WAIT_TIMEOUT) {
            return fail("GetQueuedCompletionStatus");
        }
    }
}

int wmain(int argc, wchar_t **argv)
{
    if (argc == 2 && wcscmp(argv[1], L"--version") == 0) {
        printf("asist-agent-launcher %s\n", LAUNCHER_VERSION);
        return 0;
    }
    if (argc < 2) {
        fprintf(stderr, "usage: asist-agent-launcher --version | <program.exe> [arguments...]\n");
        return 1;
    }
    if (!is_exe(argv[1])) {
        fprintf(stderr, "asist-agent-launcher: %ls is not an .exe\n", argv[1]);
        return 1;
    }

    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (job == NULL) return fail("CreateJobObject");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    ZeroMemory(&limits, sizeof limits);
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) {
        return fail("SetInformationJobObject");
    }
    HANDLE port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
    if (port == NULL) return fail("CreateIoCompletionPort");
    JOBOBJECT_ASSOCIATE_COMPLETION_PORT association;
    association.CompletionKey = job;
    association.CompletionPort = port;
    if (!SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, &association, sizeof association)) {
        return fail("SetInformationJobObject");
    }

    SIZE_T size = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &size);
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = malloc(size);
    wchar_t *line = command_line(argc, argv, 1);
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
    if (!CreateProcessW(argv[1], line, NULL, NULL, TRUE, EXTENDED_STARTUPINFO_PRESENT, NULL, NULL, &startup.StartupInfo, &child)) {
        return fail("CreateProcess");
    }
    DeleteProcThreadAttributeList(attributes);
    free(attributes);
    free(line);
    CloseHandle(child.hThread);

    if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0) return fail("WaitForSingleObject");
    DWORD exit_code;
    if (!GetExitCodeProcess(child.hProcess, &exit_code)) return fail("GetExitCodeProcess");
    CloseHandle(child.hProcess);
    int emptied = empty_job(job, port);
    if (emptied != 0) return emptied;
    return (int)exit_code;
}
