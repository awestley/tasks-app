import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// One task, edited in place: its content on the left and its details in a column on the right,
/// like the web's task view. Changes save as you go, text after a short pause.
/// On a phone the details follow the content in one column.
struct TaskDetailView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    /// The view's width, which decides between two columns and one.
    @State private var width: CGFloat = 900
    /// The tasks of the list the task was opened from, for the previous and next buttons.
    let list: [String]
    let goToProject: (String?) -> Void
    @State private var currentID: String
    @State private var title = ""
    @State private var notes = ""
    @State private var checklist: [ChecklistItem] = []
    @State private var newLabel = ""
    @State private var showDate = false
    @State private var confirmDelete = false
    @State private var pendingSave: Task<Void, Never>?
    @FocusState private var focus: Field?

    enum Field: Hashable { case title, notes, item(String), label }

    init(taskID: String, list: [String], goToProject: @escaping (String?) -> Void) {
        self.list = list
        self.goToProject = goToProject
        _currentID = State(initialValue: taskID)
    }

    var task: TodoTask? { store.allTasks.first { $0.id == currentID } }
    var wide: Bool { width >= 640 }

    var body: some View {
        following(window)
    }
    var window: some View {
        Group {
            if let task {
                layout(task)
            } else {
                ContentUnavailableView("This task was deleted", systemImage: "trash")
                    .toolbar { Button("Close") { dismiss() } }
            }
        }
        #if os(macOS)
        .frame(minWidth: 720, idealWidth: 920, minHeight: 520, idealHeight: 680)
        #endif
        .tasksErrorAlert()
        .confirmationDialog("Permanently delete this task?", isPresented: $confirmDelete) {
            Button("Delete task", role: .destructive) { deleteTask() }
        }
    }
    /// Loads the task, saves when leaving a field or the task, and follows changes from other
    /// devices and the agent, except in the field being typed in.
    func following(_ view: some View) -> some View {
        view
            .onAppear { load() }
            .onDisappear { flush(currentID) }
            .onChange(of: currentID) { (old: String, _: String) in
                flush(old)
                load()
            }
            .onChange(of: focus) { (old: Field?, _: Field?) in
                // A task keeps its name: clearing it and leaving the field restores it.
                if old == .title, title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let task { title = task.title }
                if old != nil { flush(currentID) }
            }
            .onChange(of: task?.title) { (_: String?, value: String?) in
                if focus != .title, let value { title = value }
            }
            .onChange(of: task?.description) { (_: String?, value: String?) in
                if focus != .notes, let value { notes = value }
            }
            .onChange(of: task?.checklist) { (_: [ChecklistItem]?, value: [ChecklistItem]?) in
                if let value, !editingChecklist { checklist = value }
            }
    }
    /// Saves what was typed, then closes.
    func close() {
        focus = nil
        flush(currentID)
        dismiss()
    }
    func deleteTask() {
        guard let task else { return }
        pendingSave?.cancel()
        Task { await store.perform { try await store.delete(task); dismiss() } }
    }

    func layout(_ task: TodoTask) -> some View {
        VStack(spacing: 0) {
            header(task)
            Rectangle().fill(Clean.border).frame(height: 1)
            if wide { columns(task) } else { stacked(task) }
        }
        .background(Clean.surface)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }
    func columns(_ task: TodoTask) -> some View {
        HStack(spacing: 0) {
            ScrollView { content(task).padding(.init(top: 24, leading: 24, bottom: 32, trailing: 32)) }
                .frame(maxWidth: .infinity)
            Rectangle().fill(Clean.border).frame(width: 1)
            ScrollView { details(task).padding(.horizontal, 24).padding(.bottom, 16) }
                .frame(width: 300)
                .background(Clean.subtle)
        }
    }
    func stacked(_ task: TodoTask) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                content(task)
                details(task)
                    .padding(.horizontal, 16)
                    .background(Clean.subtle, in: RoundedRectangle(cornerRadius: Clean.radiusLG, style: .continuous))
            }.padding(16)
        }
    }

    // MARK: Header

    func header(_ task: TodoTask) -> some View {
        let index = list.firstIndex(of: task.id)
        return HStack(spacing: 4) {
            Menu {
                projectChoices(task)
                Divider()
                Button { close(); goToProject(task.project_id) } label: { Label("Go to project", systemImage: "arrow.right") }
            } label: {
                ProjectName(project: project(task)).font(.subheadline).foregroundStyle(Clean.textSecondary)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .accessibilityLabel("Project")
            Spacer()
            if let index, list.count > 1 {
                Button { step(-1) } label: { Image(systemName: "chevron.up") }
                    .disabled(index == 0).help("Previous task").accessibilityLabel("Previous task")
                Button { step(1) } label: { Image(systemName: "chevron.down") }
                    .disabled(index == list.count - 1).help("Next task").accessibilityLabel("Next task")
            }
            Menu { moreActions(task) } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help("More actions").accessibilityLabel("More task actions")
            Button { close() } label: { Image(systemName: "xmark") }
                #if os(macOS)
                .keyboardShortcut(.cancelAction)
                #endif
                .help("Close").accessibilityLabel("Close task")
        }
        .buttonStyle(HeaderButtonStyle())
        .font(.body)
        .foregroundStyle(Clean.textSecondary)
        .padding(.horizontal, 12)
        .frame(height: 52)
    }

    @ViewBuilder func moreActions(_ task: TodoTask) -> some View {
        Button { Task { await store.toggle(task) } } label: {
            Label(task.completed ? "Restore" : "Complete", systemImage: task.completed ? "arrow.uturn.backward.circle" : "checkmark.circle")
        }
        if !task.completed {
            Menu {
                Button("15 minutes") { Task { await store.snooze(task, minutes: 15) } }
                Button("1 hour") { Task { await store.snooze(task, minutes: 60) } }
                Button("3 hours") { Task { await store.snooze(task, minutes: 180) } }
                Button("Tomorrow 09:00") { Task { await store.snooze(task, until: TaskActions.tomorrowMorning()) } }
            } label: { Label("Snooze", systemImage: "zzz") }
        }
        Button { Task { await store.duplicate(task) } } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
        Button { copyLink(task) } label: { Label("Copy link to task", systemImage: "link") }
        Divider()
        Button(role: .destructive) { confirmDelete = true } label: { Label("Delete task", systemImage: "trash") }
    }

    // MARK: Content: title, description, checklist, links, Flesh out

    func content(_ task: TodoTask) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Button { Task { await store.toggle(task) } } label: {
                        Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                            .font(.title2)
                            .foregroundStyle(task.completed ? Clean.inverse : Clean.priority(task.priority))
                    }
                    .buttonStyle(.plain).frame(width: Self.gutter)
                    .accessibilityLabel(task.completed ? "Restore \(task.title)" : "Complete \(task.title)")
                    TextField("Task name", text: $title, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(task.completed ? Clean.textMuted : Clean.text)
                        .focused($focus, equals: .title)
                        .onSubmit { focus = nil }
                        .onChange(of: title) { scheduleSave() }
                        .accessibilityLabel("Task title")
                }
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Image(systemName: "text.alignleft").foregroundStyle(Clean.textMuted)
                        .frame(width: Self.gutter).accessibilityHidden(true)
                    TextField("Description", text: $notes, axis: .vertical)
                        .textFieldStyle(.plain)
                        .foregroundStyle(Clean.textSecondary)
                        .lineLimit(1...)
                        .focused($focus, equals: .notes)
                        .onChange(of: notes) { scheduleSave() }
                        .accessibilityLabel("Description")
                }
            }
            checklistSection(task).padding(.leading, Self.gutter + 12)
            DetailLinks(owner: "/api/v1/tasks/\(task.id)").padding(.leading, Self.gutter + 12)
            AgentSection(taskID: task.id, changed: { Task { try? await store.refresh() } }, plain: true)
                .padding(.leading, Self.gutter + 12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    static let gutter: CGFloat = 24

    var editingChecklist: Bool { if case .item = focus { return true } else { return false } }

    func checklistSection(_ task: TodoTask) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("Checklist").font(.subheadline.weight(.semibold)).foregroundStyle(Clean.text)
                if !checklist.isEmpty {
                    Text("\(checklist.filter(\.completed).count)/\(checklist.count)")
                        .font(.subheadline).monospacedDigit().foregroundStyle(Clean.textMuted)
                }
            }
            ForEach($checklist) { $item in
                HStack(spacing: 10) {
                    Button {
                        item.completed.toggle()
                        saveChecklist()
                    } label: {
                        Image(systemName: item.completed ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(item.completed ? Clean.inverse : Clean.borderControl)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(item.completed ? "Uncheck \(item.title)" : "Check \(item.title)")
                    TextField("Item", text: $item.title)
                        .textFieldStyle(.plain)
                        .strikethrough(item.completed)
                        .foregroundStyle(item.completed ? Clean.textMuted : Clean.text)
                        .focused($focus, equals: .item(item.id))
                        .onSubmit { addItem() }
                    Button {
                        checklist.removeAll { $0.id == item.id }
                        saveChecklist()
                    } label: { Image(systemName: "xmark").font(.caption) }
                        .buttonStyle(.plain).foregroundStyle(Clean.textMuted)
                        .accessibilityLabel("Remove \(item.title)")
                }
                .padding(.vertical, 4)
                .disabled(task.completed)
            }
            if task.completed {
                Text("Reopen this task to change its checklist.").font(.caption).foregroundStyle(Clean.textMuted)
            } else {
                Button { addItem() } label: { Label("Add item", systemImage: "plus") }
                    .buttonStyle(.plain).foregroundStyle(Clean.textSecondary)
                    .disabled(checklist.count >= 100)
                    .padding(.top, 2)
            }
        }
    }

    // MARK: Details column

    func details(_ task: TodoTask) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            DetailRow("Project") {
                Menu { projectChoices(task) } label: { ProjectName(project: project(task)) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            }
            DetailRow("Date") {
                Button { showDate = true } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "calendar")
                        Text(dueText(task))
                        if task.recurrence != nil { Image(systemName: "repeat").font(.caption) }
                    }
                    .foregroundStyle(dueColor(task))
                }
                .buttonStyle(.plain)
                .popover(isPresented: $showDate, arrowEdge: wide ? .leading : .top) {
                    DueEditor(task: task, patch: patch)
                }
                .accessibilityLabel("Date, \(dueText(task))")
            }
            DetailRow("Priority") {
                Menu {
                    Picker("Priority", selection: Binding(get: { task.priority }, set: { patch(["priority": $0]) })) {
                        ForEach([(1, "Urgent"), (2, "High"), (3, "Medium"), (4, "Normal")], id: \.0) { value, name in
                            Label(name, systemImage: value == 4 ? "flag" : "flag.fill").tag(value)
                        }
                    }.pickerStyle(.inline)
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: task.priority == 4 ? "flag" : "flag.fill").foregroundStyle(Clean.priority(task.priority))
                        Text(Self.priorityName(task.priority)).foregroundStyle(Clean.text)
                    }
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .accessibilityLabel("Priority, \(Self.priorityName(task.priority))")
            }
            DetailRow("Labels") { labels(task) }
            DetailRow("Reminder") { reminder(task) }
            if task.time_zone != TimeZone.current.identifier {
                DetailRow("Time zone") { Text(task.time_zone).foregroundStyle(Clean.text).accessibilityIdentifier("taskTimeZone") }
            }
            if let snoozed = task.snoozedInstant, snoozed > Date() {
                Label("Snoozed until \(snoozed.formatted(date: .omitted, time: .shortened))", systemImage: "zzz")
                    .font(.caption).foregroundStyle(Clean.textMuted).padding(.top, 12)
            }
            Button(role: .destructive) { confirmDelete = true } label: { Label("Delete task", systemImage: "trash") }
                .buttonStyle(.plain).font(.subheadline).foregroundStyle(Clean.danger)
                .padding(.top, 20)
        }
    }

    func labels(_ task: TodoTask) -> some View {
        let others = Array(Set(store.tasks.flatMap(\.labels))).filter { !task.labels.contains($0) }.sorted()
        return VStack(alignment: .leading, spacing: 8) {
            if !task.labels.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(task.labels, id: \.self) { label in
                        HStack(spacing: 4) {
                            Text(label)
                            Button { patch(["labels": task.labels.filter { $0 != label }]) } label: { Image(systemName: "xmark").font(.caption2) }
                                .buttonStyle(.plain).foregroundStyle(Clean.textMuted).accessibilityLabel("Remove label \(label)")
                        }
                        .font(.subheadline)
                        .padding(.leading, 8).padding(.trailing, 6).padding(.vertical, 3)
                        .background(Clean.muted, in: RoundedRectangle(cornerRadius: Clean.radiusSM, style: .continuous))
                    }
                }
            }
            HStack(spacing: 6) {
                TextField("Add label", text: $newLabel)
                    .textFieldStyle(.plain)
                    .focused($focus, equals: .label)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .onSubmit { addLabel(newLabel, to: task) }
                if !others.isEmpty {
                    Menu {
                        ForEach(others, id: \.self) { label in Button(label) { addLabel(label, to: task) } }
                    } label: { Image(systemName: "chevron.down").font(.caption) }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                        .accessibilityLabel("Choose a label")
                }
            }
        }
    }

    @ViewBuilder func reminder(_ task: TodoTask) -> some View {
        if task.due_time == nil {
            Text("Give the task a time to set a reminder.").font(.subheadline).foregroundStyle(Clean.textMuted)
        } else {
            Menu {
                Picker("Reminder", selection: Binding(get: { task.reminder_minutes ?? -1 }, set: { patch(["reminder_minutes": $0 < 0 ? NSNull() : $0]) })) {
                    Text("None").tag(-1)
                    ForEach(Self.reminderChoices, id: \.0) { minutes, name in Text(name).tag(minutes) }
                    if let minutes = task.reminder_minutes, !Self.reminderChoices.contains(where: { $0.0 == minutes }) {
                        Text("\(minutes) minutes before").tag(minutes)
                    }
                }.pickerStyle(.inline)
                if task.reminder_minutes != nil {
                    Picker("Alert", selection: Binding(get: { task.alert_style ?? "notification" }, set: { patch(["alert_style": $0]) })) {
                        Text("Notification").tag("notification")
                        Text("Alarm on iPhone").tag("alarm")
                    }.pickerStyle(.inline)
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: task.isAlarm ? "alarm" : "bell")
                    Text(reminderText(task))
                }.foregroundStyle(task.reminder_minutes == nil ? Clean.textMuted : Clean.text)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .accessibilityLabel("Reminder, \(reminderText(task))")
        }
    }

    // MARK: Saving

    func load() {
        guard let task else { return }
        title = task.title
        notes = task.description
        checklist = task.checklist
        newLabel = ""
    }

    /// The changes waiting to be saved for this task, if any.
    func changes(for task: TodoTask) -> [String: Any] {
        var fields: [String: Any] = [:]
        let name = title.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if !name.isEmpty && name != task.title { fields["title"] = name }
        if notes != task.description { fields["description"] = notes }
        // A new item waits until it has a name.
        if checklist != task.checklist && !checklist.contains(where: { $0.title.trimmingCharacters(in: .whitespaces).isEmpty }) {
            fields["checklist"] = checklist.map { ["id": $0.id, "title": $0.title, "completed": $0.completed] }
        }
        return fields
    }
    func scheduleSave() {
        pendingSave?.cancel()
        let id = currentID
        pendingSave = Task {
            try? await Task.sleep(for: .milliseconds(700))
            if !Task.isCancelled { flush(id) }
        }
    }
    /// Saves typed changes now, as when leaving a field or the task.
    func flush(_ id: String) {
        pendingSave?.cancel()
        guard let saved = store.allTasks.first(where: { $0.id == id }) else { return }
        let fields = changes(for: saved)
        if !fields.isEmpty { patch(fields, id: id) }
    }
    func saveChecklist() { flush(currentID) }
    func addItem() {
        if let blank = checklist.first(where: { $0.title.trimmingCharacters(in: .whitespaces).isEmpty }) {
            focus = .item(blank.id)
            return
        }
        guard checklist.count < 100 else { return }
        let item = ChecklistItem()
        checklist.append(item)
        focus = .item(item.id)
    }
    func addLabel(_ raw: String, to task: TodoTask) {
        let label = raw.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "@")).lowercased()
        newLabel = ""
        guard !label.isEmpty, !task.labels.contains(label), task.labels.count < 20 else { return }
        patch(["labels": task.labels + [label]])
    }
    /// Changes fields of the task. A change made on another device first is kept, and this one applies on top.
    func patch(_ fields: [String: Any], id: String? = nil) {
        let id = id ?? currentID
        Task { await store.perform {
            @MainActor func send() async throws {
                guard let latest = store.allTasks.first(where: { $0.id == id }) else {
                    throw APIError(message: "This task was deleted on another device.")
                }
                let _: TodoTask = try await store.api.request("/api/v1/tasks/\(id)", method: "PATCH", body: API.body(fields.merging(["version": latest.version]) { $1 }))
            }
            do { try await send() } catch let error as APIError where error.status == 409 {
                try await store.refresh()
                try await send()
            }
            try await store.refresh()
        } }
    }

    // MARK: Helpers

    func step(_ by: Int) {
        guard let index = list.firstIndex(of: currentID), list.indices.contains(index + by) else { return }
        focus = nil
        currentID = list[index + by]
    }
    func project(_ task: TodoTask) -> Project? { store.allProjects.first { $0.id == task.project_id } }
    @ViewBuilder func projectChoices(_ task: TodoTask) -> some View {
        Picker("Project", selection: Binding(get: { task.project_id ?? "" }, set: { patch(["project_id": $0.isEmpty ? NSNull() : $0]) })) {
            Label("Inbox", systemImage: "tray").tag("")
            ForEach(store.projects) { project in Text("# " + project.name).tag(project.id) }
        }.pickerStyle(.inline)
        // Into the other space's Inbox. The task leaves this space's lists.
        Button { patch(["space": task.inSpace.other.rawValue, "project_id": NSNull()]) } label: {
            Label(task.inSpace.other.name, systemImage: task.inSpace.other.symbol)
        }
    }
    func copyLink(_ task: TodoTask) {
        let link = "\(store.server)/?task=\(task.id)"
        #if os(iOS)
        UIPasteboard.general.string = link
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(link, forType: .string)
        #endif
    }
    static let reminderChoices: [(Int, String)] = [(0, "At due time"), (5, "5 minutes before"), (15, "15 minutes before"), (30, "30 minutes before"), (60, "1 hour before"), (1440, "1 day before")]
    static func priorityName(_ value: Int) -> String { [1: "Urgent", 2: "High", 3: "Medium"][value] ?? "Normal" }
    static let recurrenceNames = ["daily": "Every day", "weekly": "Every week", "monthly": "Every month"]

    func reminderText(_ task: TodoTask) -> String {
        guard let minutes = task.reminder_minutes else { return "None" }
        return Self.reminderChoices.first { $0.0 == minutes }?.1 ?? "\(minutes) minutes before"
    }
    func dueText(_ task: TodoTask) -> String {
        guard let due = task.due_date else { return "No date" }
        let today = DateOnly.string(Date())
        let offset = Calendar.current.dateComponents([.day], from: DateOnly.date(today), to: DateOnly.date(due)).day ?? 0
        var text: String
        switch offset {
        case 0: text = "Today"
        case 1: text = "Tomorrow"
        case -1: text = "Yesterday"
        case 2..<7: text = DateOnly.date(due).formatted(.dateTime.weekday(.wide))
        default:
            let date = DateOnly.date(due)
            let sameYear = Calendar.current.component(.year, from: date) == Calendar.current.component(.year, from: Date())
            text = sameYear ? date.formatted(.dateTime.month(.abbreviated).day()) : date.formatted(.dateTime.month(.abbreviated).day().year())
        }
        if let time = task.due_time { text += " " + time }
        if let repeating = task.recurrence { text += " · " + (Self.recurrenceNames[repeating] ?? repeating) }
        return text
    }
    func dueColor(_ task: TodoTask) -> Color {
        guard let due = task.due_date else { return Clean.textMuted }
        return due < DateOnly.string(Date()) && !task.completed ? Clean.danger : Clean.text
    }
}

/// A heading over a value, separated from the next detail by a hairline.
struct DetailRow<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption.weight(.medium)).foregroundStyle(Clean.textSecondary)
            content.font(.body).foregroundStyle(Clean.text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 14).padding(.bottom, 12)
        .overlay(alignment: .bottom) { Rectangle().fill(Clean.border).frame(height: 1) }
    }
}

struct ProjectName: View {
    let project: Project?
    var body: some View {
        HStack(spacing: 6) {
            if let project {
                Text("#").foregroundStyle(Color(hex: project.color))
                Text(project.name).foregroundStyle(Clean.text)
            } else {
                Image(systemName: "tray")
                Text("Inbox").foregroundStyle(Clean.text)
            }
        }
    }
}

/// Icon buttons in the task view's header.
struct HeaderButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: 30, height: 30)
            .contentShape(Rectangle())
            .background(configuration.isPressed ? Clean.muted : .clear, in: RoundedRectangle(cornerRadius: Clean.radiusSM, style: .continuous))
            .opacity(isEnabled ? 1 : 0.3)
    }
}

/// Date, time, time zone and repeat, saved as each one changes.
struct DueEditor: View {
    let task: TodoTask
    let patch: ([String: Any], String?) -> Void
    var timeZones: [String] {
        let known = TimeZone.knownTimeZoneIdentifiers
        return known.contains(task.time_zone) ? known : [task.time_zone] + known
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                ForEach(TaskMenu.dateChoices, id: \.0) { date, name, symbol, _ in
                    Button { setDate(date) } label: { Label(name, systemImage: symbol) }
                        .help(name)
                }
                Button { clear() } label: { Label("No date", systemImage: "circle.slash") }.help("No date")
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.bordered)
            DatePicker("Date", selection: Binding(get: { task.due_date.map(DateOnly.date) ?? Date() }, set: { setDate(DateOnly.string($0)) }), displayedComponents: .date)
                .datePickerStyle(.graphical)
                .labelsHidden()
            if task.due_date != nil {
                Toggle("Time", isOn: Binding(get: { task.due_time != nil }, set: { on in
                    patch(on ? ["due_time": "09:00"] : ["due_time": NSNull(), "reminder_minutes": NSNull()], nil)
                }))
                if let time = task.due_time {
                    DatePicker("At", selection: Binding(get: { Self.clock(time) }, set: { value in
                        let parts = Calendar.current.dateComponents([.hour, .minute], from: value)
                        patch(["due_time": String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)], nil)
                    }), displayedComponents: .hourAndMinute)
                    Picker("Time zone", selection: Binding(get: { task.time_zone }, set: { patch(["time_zone": $0], nil) })) {
                        ForEach(timeZones, id: \.self) { Text($0).tag($0) }
                    }
                }
                Picker("Repeat", selection: Binding(get: { task.recurrence ?? "" }, set: { patch(["recurrence": $0.isEmpty ? NSNull() : $0], nil) })) {
                    Text("Does not repeat").tag("")
                    Text("Every day").tag("daily")
                    Text("Every week").tag("weekly")
                    Text("Every month").tag("monthly")
                }
            }
        }
        .padding(16)
        .frame(width: 300)
    }
    func setDate(_ value: String) { patch(["due_date": value], nil) }
    func clear() { patch(["due_date": NSNull(), "due_time": NSNull(), "reminder_minutes": NSNull(), "recurrence": NSNull()], nil) }
    static func clock(_ value: String) -> Date {
        let parts = value.split(separator: ":").compactMap { Int($0) }
        return Calendar.current.date(bySettingHour: parts.first ?? 9, minute: parts.last ?? 0, second: 0, of: Date()) ?? Date()
    }
}

/// Notes and web pages linked to the task. Each link saves as soon as it is added or removed.
struct DetailLinks: View {
    @EnvironmentObject var store: Store
    let owner: String
    @State private var links: [ItemLink] = []
    @State private var target = ""
    @State private var title = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("Links").font(.subheadline.weight(.semibold)).foregroundStyle(Clean.text)
                if !links.isEmpty { Text("\(links.count)").font(.subheadline).foregroundStyle(Clean.textMuted) }
            }
            ForEach(links) { link in
                HStack(spacing: 10) {
                    Image(systemName: link.ref == nil ? "link" : "doc.text").foregroundStyle(Clean.textMuted).frame(width: 16)
                    if let address = link.url, let url = URL(string: address) {
                        Link(link.title, destination: url).foregroundStyle(Clean.accent)
                    } else {
                        Text(link.title).foregroundStyle(Clean.text).help(link.ref ?? "")
                    }
                    Spacer()
                    Button { remove(link) } label: { Image(systemName: "xmark").font(.caption) }
                        .buttonStyle(.plain).foregroundStyle(Clean.textMuted)
                        .accessibilityLabel("Remove link \(link.title)")
                }.padding(.vertical, 4)
            }
            HStack(spacing: 10) {
                Image(systemName: "plus").foregroundStyle(Clean.textMuted).frame(width: 16)
                TextField("Paste a note or web address", text: $target)
                    .textFieldStyle(.plain)
                    .autocorrectionDisabled()
                    .onSubmit { add() }
                if !target.isEmpty {
                    TextField("Title", text: $title).textFieldStyle(.plain).frame(maxWidth: 160).onSubmit { add() }
                    Button("Add") { add() }.disabled(store.busy)
                }
            }.padding(.vertical, 4)
        }
        .task(id: owner) {
            do { links = try await store.api.request(owner + "/links") } catch { store.report(error) }
        }
    }
    func add() {
        let value = target.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { return }
        let name = title.trimmingCharacters(in: .whitespaces)
        Task { await store.perform {
            let link: ItemLink = try await store.api.request(owner + "/links", method: "POST", body: API.body([value.hasPrefix("pc://") ? "ref" : "url": value, "title": name]))
            links.removeAll { $0.id == link.id }
            links.append(link)
            target = ""; title = ""
        } }
    }
    func remove(_ link: ItemLink) {
        Task { await store.perform {
            try await store.api.send(owner + "/links/\(link.id)", method: "DELETE")
            links.removeAll { $0.id == link.id }
        } }
    }
}

/// Lays its children out in rows, wrapping to the next row when one is full.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width { x = 0; y += row + spacing; row = 0 }
            x += size.width + spacing
            widest = max(widest, x - spacing)
            row = max(row, size.height)
        }
        return CGSize(width: min(widest, width), height: y + row)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX { x = bounds.minX; y += row + spacing; row = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}
