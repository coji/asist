import Foundation
import EventKit
import CryptoKit

// One request per process. Calendar contents travel through stdin/stdout only, never argv or logs.
// A failure is reported as a code that src/main/services/calendar.ts turns into a message, so that the
// message is written in the language of whoever reads it.
struct Failure: Error { let code: String }
func fail(_ code: String) throws -> Never { throw Failure(code: code) }
let store = EKEventStore()
func authorization() -> String {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .fullAccess: return "fullAccess"
    case .writeOnly: return "writeOnly"
    @unknown default: fatalError("Unsupported Calendar authorization status")
    }
}
func account(_ calendar: EKCalendar) -> [String: Any] {
    ["id": calendar.calendarIdentifier, "title": calendar.title, "source": calendar.source.title,
     "writable": calendar.allowsContentModifications]
}
func status() -> [String: Any] {
    ["authorization": authorization(), "calendars": authorization() == "fullAccess" ? store.calendars(for: .event).map(account) : []]
}
// ASIST ends an all-day event at midnight after its last day, exclusive like every other end. EventKit
// is described as ignoring the time of day of an all-day event's dates and as reporting the end as
// 23:59:59 of the last day, which has not been checked on a Mac. These two functions are the only
// place where the two conventions meet, and each gives the same result under either of them.
// Reading: the last day is the day that holds the second before endDate, so an end of 23:59:59 on the
// last day and one of 00:00 on the day after both come back as 00:00 on the day after.
func appEnd(of event: EKEvent, in zone: TimeZone) throws -> Date {
    guard event.isAllDay else { return event.endDate }
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
    let lastDay = calendar.startOfDay(for: event.endDate.addingTimeInterval(-1))
    guard let end = calendar.date(byAdding: .day, value: 1, to: lastDay) else { try fail("eventKitFailed") }
    return end
}
// Writing: 23:59:59 of the last day is the last day whether EventKit ignores the time or keeps it.
func eventKitEnd(fromAppEnd end: Date, allDay: Bool) -> Date {
    allDay ? end.addingTimeInterval(-1) : end
}
func eventData(_ event: EKEvent) throws -> [String: Any] {
    guard let id = event.eventIdentifier else { try fail("eventKitFailed") }
    // An all-day event floats in the zone of the Mac, and EventKit gives it no zone of its own.
    let zone = event.timeZone ?? TimeZone.current
    var data: [String: Any] = [
        "id": id, "calendarId": event.calendar.calendarIdentifier, "calendarTitle": event.calendar.title,
        "title": event.title ?? "", "start": event.startDate.timeIntervalSince1970 * 1000,
        "end": try appEnd(of: event, in: zone).timeIntervalSince1970 * 1000, "allDay": event.isAllDay,
        "location": event.location ?? "", "notes": event.notes ?? "",
        "timeZone": zone.identifier,
        "recurring": event.hasRecurrenceRules || event.isDetached,
        // Google can set an organizer even on personal events without invitees.
        "hasAttendees": event.hasAttendees,
        "writable": event.calendar.allowsContentModifications
    ]
    // Include modification time as well as the displayed fields: external edits invalidate approval.
    data["modified"] = event.lastModifiedDate?.timeIntervalSince1970 ?? 0
    let encoded = try JSONSerialization.data(withJSONObject: data, options: [.sortedKeys])
    data.removeValue(forKey: "modified")
    data["revision"] = SHA256.hash(data: encoded).map { String(format: "%02x", $0) }.joined()
    return data
}
// ASIST checks what it sends before it sends it, so input that does not read is a defect of ASIST,
// reported as badRequest.
func text(_ input: [String: Any], _ key: String) throws -> String {
    guard let value = input[key] as? String else { try fail("badRequest") }
    return value
}
func date(_ input: [String: Any], _ key: String) throws -> Date {
    let value = try text(input, key)
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let result = format.date(from: value) { return result }
    format.formatOptions = [.withInternetDateTime]
    guard let result = format.date(from: value) else { try fail("badRequest") }
    return result
}
func existing(_ input: [String: Any]) throws -> EKEvent {
    guard let event = store.event(withIdentifier: try text(input, "eventId")) else { try fail("eventNotFound") }
    return event
}
func writable(_ calendar: EKCalendar) throws {
    guard calendar.allowsContentModifications else { try fail("destinationUnwritable") }
}
func perform(_ input: [String: Any]) async throws -> Any {
    let operation = try text(input, "operation")
    if operation == "status" { return status() }
    if operation == "requestAccess" {
        _ = try await store.requestFullAccessToEvents()
        return status()
    }
    guard authorization() == "fullAccess" else { try fail("needsFullAccess") }
    if operation == "search" {
        guard let ids = input["calendarIds"] as? [String], !ids.isEmpty else { try fail("noReadCalendars") }
        let calendars = try ids.map { id -> EKCalendar in
            guard let calendar = store.calendar(withIdentifier: id) else { try fail("calendarNotFound") }
            return calendar
        }
        let start = try date(input, "start"), end = try date(input, "end")
        guard end > start, end.timeIntervalSince(start) <= 366 * 86400 else { try fail("badRequest") }
        // EventKit does not document whether its predicate takes an event that only touches the range.
        // If it tests overlap strictly, an event without length at `start` is never matched, so the
        // predicate starts a minute earlier. Times in Calendar are set in whole minutes, so the minute
        // brings in only events that end at `start` or just before it, and calendar-service.ts applies
        // the exact range to what comes back.
        let predicate = store.predicateForEvents(withStart: start.addingTimeInterval(-60), end: end, calendars: calendars)
        return try store.events(matching: predicate).sorted { $0.startDate < $1.startDate }.map(eventData)
    }
    if operation == "get" { return try eventData(existing(input)) }
    guard ["create", "update", "delete"].contains(operation) else { try fail("badRequest") }
    let event: EKEvent
    if operation == "create" {
        guard let calendar = store.calendar(withIdentifier: try text(input, "calendarId")) else { try fail("destinationUnwritable") }
        try writable(calendar)
        event = EKEvent(eventStore: store)
        event.calendar = calendar
    } else {
        event = try existing(input)
        try writable(event.calendar)
        guard !event.hasRecurrenceRules && !event.isDetached && !event.hasAttendees else { try fail("locked") }
        guard try text(input, "revision") == eventData(event)["revision"] as? String else { try fail("changedSinceConfirm") }
    }
    if operation == "delete" {
        let before = try eventData(event)
        try store.remove(event, span: .thisEvent, commit: true)
        return before
    }
    guard let fields = input["event"] as? [String: Any] else { try fail("badRequest") }
    let start = try date(fields, "start"), end = try date(fields, "end")
    guard end > start, let allDay = fields["allDay"] as? Bool,
          let zone = TimeZone(identifier: try text(fields, "timeZone")) else { try fail("badRequest") }
    let title = try text(fields, "title").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { try fail("badRequest") }
    if allDay {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        guard calendar.startOfDay(for: start) == start && calendar.startOfDay(for: end) == end else { try fail("badRequest") }
    }
    event.title = title; event.startDate = start; event.endDate = eventKitEnd(fromAppEnd: end, allDay: allDay)
    event.isAllDay = allDay; event.timeZone = zone
    event.location = try text(fields, "location"); event.notes = try text(fields, "notes")
    try store.save(event, span: .thisEvent, commit: true)
    return try eventData(event)
}

Task {
    do {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard let input = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { try fail("badRequest") }
        let result = try await perform(input)
        let output = try JSONSerialization.data(withJSONObject: ["ok": true, "data": result], options: [.sortedKeys])
        FileHandle.standardOutput.write(output)
        exit(0)
    } catch {
        // Do not emit EventKit errors, which may contain user data.
        let code = (error as? Failure)?.code ?? "eventKitFailed"
        let output = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": code])
        FileHandle.standardOutput.write(output)
        exit(0)
    }
}
RunLoop.main.run()
