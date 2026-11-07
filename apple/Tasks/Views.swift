import SwiftUI
import AuthenticationServices
#if os(iOS)
import UIKit
#else
import AppKit
#endif

private struct StoreErrorAlert: ViewModifier {
    @EnvironmentObject var store: Store
    var active: Bool
    func body(content: Content) -> some View {
        content.alert("Something needs your attention", isPresented: Binding(
            get: { active && store.error != nil },
            set: { if active && !$0 { store.error = nil } }
        )) {
            Button("OK") { store.error = nil }
        } message: { Text(store.error ?? "") }
    }
}
private extension View {
    func tasksErrorAlert(active: Bool = true) -> some View {
        modifier(StoreErrorAlert(active: active))
    }
}

struct RootView: View {
    @EnvironmentObject var store: Store
    var body: some View {
        if store.profile == nil { LoginView() } else { WorkspaceView() }
    }
}
struct LoginView: View {
    @EnvironmentObject var store: Store
    @State private var server = ""
    @State private var challenge: AppleChallenge?
    @State private var preparing = false
    @Environment(\.colorScheme) private var colorScheme
    #if DEBUG
    @State private var developmentToken = ""
    #endif
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            Image(systemName: "checkmark.square.fill").accessibilityHidden(true).font(.title2.bold()).foregroundStyle(Glassive.mark)
            Text("Sign in").font(.title.bold())
            TextField("Your server URL", text: $server).textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                #if os(iOS)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                #endif
                .onChange(of: server) { _, _ in challenge = nil }
            if let challenge {
                SignInWithAppleButton(.continue) { request in
                    request.requestedScopes = [.email, .fullName]
                    request.nonce = challenge.nonce
                } onCompletion: { result in
                    Task {
                        await store.perform {
                            let authorization = try result.get()
                            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                                  let data = credential.authorizationCode,
                                  let code = String(data: data, encoding: .utf8) else {
                                throw APIError(message: "Apple did not return an authorization code.")
                            }
                            try await store.signIn(code: code, challenge: challenge.challenge_id)
                        }
                        self.challenge = nil
                    }
                }.frame(height: 46).clipShape(Capsule()).signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black).disabled(store.busy)
            } else {
                Button(preparing ? "Connecting..." : "Connect") { Task { await prepare() } }
                    .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).controlSize(.large).disabled(preparing)
            }
            #if DEBUG
            DisclosureGroup("Local development") {
                SecureField("Personal access token from the web app", text: $developmentToken).textFieldStyle(.roundedBorder)
                Button("Use development token") {
                    Task { await store.perform {
                        try store.connect(server: server)
                        try Keychain.save(developmentToken, server: store.server)
                        try await store.refresh()
                        developmentToken = ""
                    } }
                }.disabled(developmentToken.isEmpty || store.busy)
            }.font(.caption)
            #endif
        }.padding(36).frame(maxWidth: 460)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Glassive.backgroundSecondary)
            .tasksErrorAlert()
            .onAppear { server = store.server }
    }
    func prepare() async {
        preparing = true
        defer { preparing = false }
        do {
            try store.connect(server: server)
            let result: AppleChallenge = try await store.api.request("/auth/apple/challenge", method: "POST", body: API.body(["client_id": Bundle.main.bundleIdentifier ?? ""]))
            challenge = result
        } catch { store.error = error.localizedDescription }
    }
}
private struct TaskEditorSelection: Identifiable {
    let task: TodoTask?
    var id: String { task?.id ?? "new" }
}
private struct ProjectEditorSelection: Identifiable {
    let project: Project?
    var id: String { project?.id ?? "new" }
}
struct WorkspaceView: View {
    @ObservedObject private var notifications = Notifications.shared
    @EnvironmentObject var store: Store
    @State private var selection: String? = "today"
    @State private var search = ""
    @State private var editor: TaskEditorSelection?
    @State private var showSettings = false
    @State private var projectEditor: ProjectEditorSelection?
    @State private var pendingDelete: TodoTask?
    @State private var pendingProjectDelete: Project?
    var today: String { DateOnly.string(Date()) }
    func addTask(in list: String) {
        selection = list
        search = ""
        editor = TaskEditorSelection(task: nil)
    }
    var title: String {
        if let project = store.projects.first(where: { $0.id == selection }) { return project.name }
        if let selection, selection.hasPrefix("label:") { return String(selection.dropFirst(6)) }
        return ["today":"Today", "inbox":"Inbox", "upcoming":"Upcoming", "all":"All tasks", "completed":"Completed"][selection ?? "today"] ?? "Today"
    }
    var filtered: [TodoTask] {
        let today = today
        return store.tasks.filter { task in
            if !search.isEmpty { return (task.title + " " + task.description + " " + task.labels.joined(separator: " ")).localizedCaseInsensitiveContains(search) }
            if selection == "completed" { return task.completed }
            guard !task.completed else { return false }
            switch selection {
            case "today": return task.due_date.map { $0 <= today } ?? false
            case "upcoming": return task.due_date.map { $0 > today } ?? false
            case "inbox": return task.project_id == nil
            case "all", nil: return true
            default:
                if let selection, selection.hasPrefix("label:") { return task.labels.contains(String(selection.dropFirst(6))) }
                return task.project_id == selection
            }
        }.sorted { ($0.due_date ?? "9999", $0.priority, $0.title) < ($1.due_date ?? "9999", $1.priority, $1.title) }
    }
    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section {
                    ForEach([("inbox", "Inbox", "tray"), ("today", "Today", "sun.max"), ("upcoming", "Upcoming", "calendar"), ("all", "All tasks", "square.stack")], id: \.0) { tag, name, symbol in
                        Label(name, systemImage: symbol).tag(tag)
                            .contextMenu { Button { addTask(in: tag) } label: { Label("Add task", systemImage: "plus") } }
                    }
                    Label("Completed", systemImage: "checkmark.circle").tag("completed")
                }
                Section("My projects") {
                    ForEach(store.projects) { project in
                        Label { Text(project.name) } icon: { Text("#").foregroundStyle(Color(hex: project.color)) }
                            .tag(project.id)
                            .contextMenu {
                                Button { addTask(in: project.id) } label: { Label("Add task", systemImage: "plus") }
                                Button { projectEditor = ProjectEditorSelection(project: project) } label: { Label("Edit project", systemImage: "pencil") }
                                Divider()
                                Button(role: .destructive) { pendingProjectDelete = project } label: { Label("Delete project", systemImage: "trash") }
                            }
                    }
                    Button { projectEditor = ProjectEditorSelection(project: nil) } label: { Label("Add project", systemImage: "plus") }
                }
                Section("Labels") {
                    ForEach(Array(Set(store.tasks.flatMap(\.labels))).sorted(), id: \.self) { label in
                        Label(label, systemImage: "tag").tag("label:" + label)
                    }
                }
            }.navigationTitle("")
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        Image(systemName: "checkmark.square.fill").foregroundStyle(Glassive.mark).accessibilityHidden(true)
                    }
                    ToolbarItem { Button { showSettings = true } label: { Image(systemName: "gearshape") }.help("Settings").accessibilityLabel("Settings") }
                }
        } detail: {
            VStack(alignment: .leading, spacing: 0) {
                if selection == "today", search.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(Date(), format: .dateTime.weekday(.wide).month(.wide).day()).font(.subheadline).foregroundStyle(.secondary)
                    }.padding(24)
                }
                if filtered.isEmpty {
                    ContentUnavailableView(search.isEmpty ? "No tasks" : "Nothing found", systemImage: "checkmark.circle", description: Text(search.isEmpty ? "Use the add button to create a task." : "Try another word."))
                } else {
                    List {
                        ForEach(filtered) { task in
                            HStack(alignment: .top, spacing: 12) {
                                Button { Task { await store.toggle(task) } } label: {
                                    Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                                        .font(.title3).foregroundStyle(task.completed ? Glassive.accent : Glassive.priority(task.priority))
                                }.buttonStyle(.plain).disabled(store.busy).accessibilityLabel(task.completed ? "Restore \(task.title)" : "Complete \(task.title)")
                                Button { editor = TaskEditorSelection(task: task) } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(task.title).font(.body).strikethrough(task.completed).foregroundStyle(task.completed ? .secondary : .primary)
                                        if !task.description.isEmpty { Text(task.description).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                                        HStack(spacing: 8) {
                                            if let due = task.due_date {
                                                Label(DateOnly.date(due).formatted(date: .abbreviated, time: .omitted), systemImage: task.recurrence == nil ? "calendar" : "repeat")
                                                    .foregroundStyle(due < today && !task.completed ? Glassive.red : due == today ? Glassive.textAccent : Color.secondary)
                                            }
                                            if let time = task.due_time { Text("\(time) \(task.time_zone)").foregroundStyle(.secondary) }
                                            if task.reminder_minutes != nil { Image(systemName: "bell").accessibilityLabel("Reminder set") }
                                            if !task.checklist.isEmpty {
                                                Label("\(task.checklist.filter { $0.completed }.count)/\(task.checklist.count)", systemImage: "checklist")
                                                    .foregroundStyle(.secondary)
                                                    .accessibilityLabel("\(task.checklist.filter { $0.completed }.count) of \(task.checklist.count) checklist items completed")
                                            }
                                            if !task.labels.isEmpty { Label(task.labels.joined(separator: " "), systemImage: "tag").foregroundStyle(.secondary) }
                                        }.font(.caption)
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                }.buttonStyle(.plain)
                            }.padding(.vertical, 6)
                            .listRowBackground(Glassive.backgroundPrimary)
                            .listRowSeparatorTint(Glassive.border)
                            .contextMenu {
                                TaskMenu(task: task, edit: { editor = TaskEditorSelection(task: task) },
                                         goToProject: { search = ""; selection = task.project_id ?? "inbox" },
                                         delete: { pendingDelete = task })
                            }
                            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                Button { Task { await store.toggle(task) } } label: {
                                    Label(task.completed ? "Restore" : "Complete", systemImage: task.completed ? "arrow.uturn.backward" : "checkmark")
                                }.tint(task.completed ? Glassive.accent : Glassive.green)
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button { pendingDelete = task } label: { Label("Delete", systemImage: "trash") }.tint(Glassive.red)
                                Button { editor = TaskEditorSelection(task: task) } label: { Label("Edit", systemImage: "pencil") }.tint(Glassive.accent)
                            }
                        }
                    }.listStyle(.plain).scrollContentBackground(.hidden).refreshable { await store.perform { try await store.refresh() } }
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(Glassive.backgroundPrimary)
                .navigationTitle(search.isEmpty ? title : "Search results")
                .searchable(text: $search, prompt: "Search tasks")
                .toolbar {
                    Button { Task { await store.perform { try await store.refresh() } } } label: { Image(systemName: "arrow.clockwise") }.disabled(store.busy).help("Refresh")
                    Button { editor = TaskEditorSelection(task: nil) } label: { Label("Add task", systemImage: "plus") }.keyboardShortcut("n", modifiers: .command)
                }
        }
        // Initial covers a tap that launched the app, which arrives before this view exists.
        .onChange(of: notifications.selectedTaskID, initial: true) { _, id in
            guard let id else { return }
            if let target = store.tasks.first(where: { $0.id == id }) { editor = TaskEditorSelection(task: target) }
            notifications.selectedTaskID = nil
        }
        .sheet(item: $editor) { destination in TaskEditorView(task: destination.task, initialProject: store.projects.contains(where: { $0.id == selection }) ? selection : nil, initialDate: selection == "today" ? Date() : nil) }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(item: $projectEditor) { ProjectEditorView(project: $0.project) }
        .tasksErrorAlert(active: editor == nil && projectEditor == nil && !showSettings)
        .confirmationDialog("Permanently delete this task?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), presenting: pendingDelete) { task in
            Button("Delete task", role: .destructive) { Task { await store.perform { try await store.delete(task) } } }
        }
        .confirmationDialog("Delete this project? Its tasks will move to Inbox.", isPresented: Binding(get: { pendingProjectDelete != nil }, set: { if !$0 { pendingProjectDelete = nil } }), presenting: pendingProjectDelete) { project in
            Button("Delete project", role: .destructive) { Task { await store.perform {
                try await store.api.send("/api/v1/projects/\(project.id)", method: "DELETE")
                if selection == project.id { selection = "inbox" }
                try await store.refresh()
            } } }
        }
    }
}
/// Right-click and long-press actions for a task, matching the web menu.
struct TaskMenu: View {
    @EnvironmentObject var store: Store
    let task: TodoTask
    let edit: () -> Void
    let goToProject: () -> Void
    let delete: () -> Void
    static func day(_ offset: Int) -> String {
        DateOnly.string(Calendar.current.date(byAdding: .day, value: offset, to: Date()) ?? Date())
    }
    var dates: [(String, String, String, Color)] {
        let weekday = Calendar.current.component(.weekday, from: Date()) // Sunday is 1
        let options = [(Self.day(0), "Today", "calendar", Glassive.green), (Self.day(1), "Tomorrow", "sunrise", Glassive.orange),
                       (Self.day(weekday == 1 ? 0 : 7 - weekday), "This weekend", "sofa", Glassive.accent),
                       (Self.day((9 - weekday) % 7 == 0 ? 7 : (9 - weekday) % 7), "Next week", "arrow.right.to.line", Color.purple)]
        // The weekend can be today or tomorrow; keep one choice per date.
        return options.filter { option in options.first { $0.0 == option.0 }?.1 == option.1 }
    }
    var body: some View {
        Button(action: edit) { Label("Edit", systemImage: "pencil") }
        Button(action: goToProject) { Label("Go to project", systemImage: "list.bullet.indent") }
        Button { Task { await store.toggle(task) } } label: {
            Label(task.completed ? "Restore" : "Complete", systemImage: task.completed ? "arrow.uturn.backward.circle" : "checkmark.circle")
        }
        Divider()
        Section("Date") {
            Picker("Date", selection: Binding(get: { task.due_date ?? "" }, set: { value in
                Task { await store.update(task, value.isEmpty ? ["due_date": NSNull(), "due_time": NSNull(), "reminder_minutes": NSNull(), "recurrence": NSNull()] : ["due_date": value]) }
            })) {
                // Palette pickers color each symbol with its tint.
                ForEach(dates, id: \.0) { date, name, symbol, color in Label(name, systemImage: symbol).tint(color).tag(date) }
                Label("No date", systemImage: "circle.slash").tint(Color.secondary).tag("")
            }.pickerStyle(.palette).menuActionDismissBehavior(.enabled)
        }
        Section("Priority") {
            Picker("Priority", selection: Binding(get: { task.priority }, set: { value in Task { await store.update(task, ["priority": value]) } })) {
                ForEach([(1, "Urgent"), (2, "High"), (3, "Medium"), (4, "Normal")], id: \.0) { value, name in
                    Label(name, systemImage: value == 4 ? "flag" : "flag.fill").tint(Glassive.priority(value)).tag(value)
                }
            }.pickerStyle(.palette).menuActionDismissBehavior(.enabled)
        }
        Divider()
        if task.due_time != nil {
            Picker(selection: Binding(get: { task.reminder_minutes ?? -1 }, set: { value in
                Task { await store.update(task, ["reminder_minutes": value < 0 ? NSNull() : value]) }
            })) {
                Text("None").tag(-1)
                Text("At due time").tag(0)
                ForEach([5, 15, 30], id: \.self) { Text("\($0) minutes before").tag($0) }
                Text("1 hour before").tag(60)
                Text("1 day before").tag(1440)
            } label: { Label("Reminder", systemImage: "bell") }.pickerStyle(.menu)
        }
        Picker(selection: Binding(get: { task.project_id ?? "" }, set: { value in
            Task { await store.update(task, ["project_id": value.isEmpty ? NSNull() : value]) }
        })) {
            Label("Inbox", systemImage: "tray").tag("")
            ForEach(store.projects) { project in Text("# " + project.name).tag(project.id) }
        } label: { Label("Move to", systemImage: "folder") }.pickerStyle(.menu)
        Button { Task { await store.duplicate(task) } } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
        Button {
            let link = "\(store.server)/?task=\(task.id)"
            #if os(iOS)
            UIPasteboard.general.string = link
            #else
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(link, forType: .string)
            #endif
        } label: { Label("Copy link to task", systemImage: "link") }
        Divider()
        Button(role: .destructive, action: delete) { Label("Delete task", systemImage: "trash") }
    }
}
struct TaskEditorView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) var dismiss
    let task: TodoTask?
    let initialProject: String?
    let initialDate: Date?
    @State private var draft = TaskDraft()
    @State private var date = Date()
    @State private var hasDate = false
    @State private var labels = ""
    @State private var deleteConfirmation = false
    @State private var smart = false
    @State private var parsed: ParsedTask?
    @State private var parsedInput = ""
    @State private var parsing = false
    @State private var parseError = ""
    @State private var clock = Date()
    @State private var hasTime = false
    var detected: ParsedTask? { smart && parsedInput == draft.title && !(parsed?.recognized.isEmpty ?? true) ? parsed : nil }
    /// Apple's list has no "UTC", the default for tasks from the API and MCP, so keep the task's own zone selectable.
    var timeZones: [String] {
        let known = TimeZone.knownTimeZoneIdentifiers
        return known.contains(draft.time_zone) ? known : [draft.time_zone] + known
    }
    func resolvedDraft() -> TaskDraft {
        var result = draft
        result.due_date = hasDate ? DateOnly.string(date) : nil
        let parts = Calendar.current.dateComponents([.hour, .minute], from: clock)
        result.due_time = hasDate && hasTime ? String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0) : nil
        if result.due_time == nil { result.reminder_minutes = nil }
        if !hasDate { result.recurrence = nil }
        result.labels = labels.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if let value = detected {
            result.title = value.title
            result.due_date = value.due_date ?? result.due_date
            result.due_time = value.due_time ?? result.due_time
            if value.due_time != nil { result.reminder_minutes = value.reminder_minutes }
            result.recurrence = value.recurrence ?? result.recurrence
            result.priority = value.priority ?? result.priority
            result.project_id = value.project_id ?? result.project_id
            result.labels = Array(Set(result.labels + value.labels)).sorted()
        }
        return result
    }
    /// Keeps the draft and adopts the latest version, so the next attempt succeeds on purpose.
    func conflict(_ retry: String) async throws -> APIError {
        try await store.refresh()
        guard let latest = store.tasks.first(where: { $0.id == task?.id }) else {
            return APIError(message: "This task was deleted on another device.")
        }
        draft.version = latest.version
        return APIError(message: "This task changed on another device. " + retry)
    }
    func loadTime(_ value: String?) {
        hasTime = value != nil
        let parts = (value ?? "09:00").split(separator: ":").compactMap { Int($0) }
        clock = Calendar.current.date(bySettingHour: parts.first ?? 9, minute: parts.last ?? 0, second: 0, of: Date()) ?? Date()
    }
    var body: some View {
        NavigationStack {
            Form {
                TextField("Task title, e.g. Order pizza Friday afternoon", text: $draft.title)
                Toggle("Detect dates, times and details", isOn: $smart)
                if parsing { ProgressView("Reading details...") }
                if !parseError.isEmpty { Text(parseError + " Turn off detail detection to enter fields manually.").foregroundStyle(.red) }
                if let value = detected {
                    Section("Detected details") {
                        Text(value.title).font(.headline)
                        Text([value.due_date, value.due_time, value.due_time == nil ? nil : value.time_zone, value.recurrence, value.priority.map { "Priority \($0)" }, value.labels.isEmpty ? nil : value.labels.joined(separator: ", "), store.projects.first(where: { $0.id == value.project_id })?.name].compactMap { $0 }.joined(separator: " · "))
                        if value.due_time != nil { Text(value.reminder_minutes == 0 ? "Reminder at due time" : "Reminder \(value.reminder_minutes ?? 0) minutes before") }
                        Button("Use details and edit") {
                            draft = resolvedDraft(); hasDate = draft.due_date != nil
                            date = draft.due_date.map(DateOnly.date) ?? Date()
                            loadTime(draft.due_time); labels = draft.labels.joined(separator: ", "); smart = false
                        }
                    }
                }
                TextField("Description", text: $draft.description, axis: .vertical).lineLimit(3...6)
                Section("Checklist") {
                    ForEach($draft.checklist) { $item in
                        HStack {
                            Button { item.completed.toggle() } label: {
                                Image(systemName: item.completed ? "checkmark.square.fill" : "square")
                            }.buttonStyle(.plain).accessibilityLabel("Toggle \(item.title)")
                            TextField("Item title", text: $item.title).strikethrough(item.completed)
                            Button(role: .destructive) { draft.checklist.removeAll { $0.id == item.id } } label: {
                                Image(systemName: "xmark")
                            }.buttonStyle(.plain).accessibilityLabel("Remove \(item.title)")
                        }.disabled(task?.completed == true)
                    }
                    if task?.completed == true {
                        Text("Reopen this task to change its checklist.").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Button { draft.checklist.append(ChecklistItem()) } label: { Label("Add item", systemImage: "plus") }
                            .disabled(draft.checklist.count >= 100)
                    }
                }
                Section {
                Picker("Project", selection: $draft.project_id) {
                    Text("Inbox").tag(nil as String?)
                    ForEach(store.projects) { Text($0.name).tag(Optional($0.id)) }
                }
                Toggle("Due date", isOn: $hasDate)
                if hasDate {
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                    Toggle("Due time", isOn: $hasTime)
                    if hasTime {
                        DatePicker("Time", selection: $clock, displayedComponents: .hourAndMinute)
                        Picker("Time zone", selection: $draft.time_zone) {
                            ForEach(timeZones, id: \.self) { Text($0).tag($0) }
                        }
                        Picker("Reminder", selection: $draft.reminder_minutes) {
                            Text("None").tag(nil as Int?)
                            Text("At due time").tag(Optional(0))
                            ForEach([5, 15, 30, 60, 1440], id: \.self) { Text("\($0) minutes before").tag(Optional($0)) }
                            if let minutes = draft.reminder_minutes, ![0,5,15,30,60,1440].contains(minutes) { Text("\(minutes) minutes before").tag(Optional(minutes)) }
                        }
                    }
                    Picker("Repeat", selection: $draft.recurrence) {
                        Text("Does not repeat").tag(nil as String?)
                        Text("Every day").tag(Optional("daily"))
                        Text("Every week").tag(Optional("weekly"))
                        Text("Every month").tag(Optional("monthly"))
                    }
                }
                Picker("Priority", selection: $draft.priority) {
                    Text("Urgent").tag(1); Text("High").tag(2); Text("Medium").tag(3); Text("Normal").tag(4)
                }
                TextField("Labels, separated by commas", text: $labels)
                }.disabled(detected != nil)
                if task != nil { Button("Delete task", role: .destructive) { deleteConfirmation = true } }
            }.formStyle(.grouped).navigationTitle(task == nil ? "Add task" : "Edit task")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { Task { await store.perform {
                            do { try await store.save(resolvedDraft(), id: task?.id) }
                            catch let error as APIError where error.status == 409 {
                                throw try await conflict("Your edits are still here. Save again to replace that change, or cancel to keep it.")
                            }
                            dismiss()
                        } } }.disabled(store.busy || parsing || !parseError.isEmpty || (smart && parsedInput != draft.title) || draft.title.trimmingCharacters(in: .whitespaces).isEmpty || draft.checklist.contains { $0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
                    }
                }
        }.frame(idealWidth: 520, idealHeight: 560)
            .tasksErrorAlert()
            .onAppear {
                if let task {
                    draft = TaskDraft(title: task.title, description: task.description, project_id: task.project_id, due_date: task.due_date, due_time: task.due_time, time_zone: task.time_zone, reminder_minutes: task.reminder_minutes, priority: task.priority, labels: task.labels, checklist: task.checklist, recurrence: task.recurrence, version: task.version)
                    labels = task.labels.joined(separator: ", ")
                    loadTime(task.due_time)
                    hasDate = task.due_date != nil
                    date = task.due_date.map(DateOnly.date) ?? Date()
                } else { smart = true; draft.project_id = initialProject; hasDate = initialDate != nil; date = initialDate ?? Date() }
            }
            .task(id: draft.title + draft.time_zone + String(smart)) {
                parsed = nil; parsedInput = ""; parseError = ""
                guard smart, !draft.title.trimmingCharacters(in: .whitespaces).isEmpty else { parsing = false; return }
                parsing = true
                let input = draft.title
                do {
                    try await Task.sleep(for: .milliseconds(250))
                    let value: ParsedTask = try await store.api.request("/api/v1/tasks/parse", method: "POST", body: API.body(["text": input, "time_zone": draft.time_zone]))
                    try Task.checkCancellation()
                    parsed = value; parsedInput = input; parsing = false
                } catch {
                    if !Task.isCancelled { parseError = error.localizedDescription; parsing = false }
                }
            }
            .confirmationDialog("Permanently delete this task?", isPresented: $deleteConfirmation) {
                Button("Delete task", role: .destructive) { if let task { Task { await store.perform {
                    var target = task
                    target.version = draft.version ?? task.version
                    do { try await store.delete(target) }
                    catch let error as APIError where error.status == 409 {
                        throw try await conflict("Confirm delete again to remove it anyway.")
                    }
                    dismiss()
                } } } }
            }
    }
}
struct ProjectEditorView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) var dismiss
    let project: Project?
    @State private var name = ""
    @State private var color = "#2563eb"
    @State private var confirmDelete = false
    var body: some View {
        NavigationStack {
            Form {
                TextField("Project name", text: $name)
                Picker("Color", selection: $color) {
                    ForEach(["#2563eb", "#9eafa0", "#ceae7b", "#c98277", "#7babc1"], id: \.self) { value in
                        Label(value, systemImage: "circle.fill").foregroundStyle(Color(hex: value)).tag(value)
                    }
                }
                if project != nil { Button("Delete project", role: .destructive) { confirmDelete = true } }
            }.formStyle(.grouped).navigationTitle(project == nil ? "Add project" : "Edit project")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { Task { await store.perform {
                            let _: Project = try await store.api.request(project.map { "/api/v1/projects/\($0.id)" } ?? "/api/v1/projects", method: project == nil ? "POST" : "PATCH", body: API.body(["name": name, "color": color]))
                            try await store.refresh(); dismiss()
                        } } }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || store.busy)
                    }
                }
        }.frame(idealWidth: 450, idealHeight: 300)
            .tasksErrorAlert()
            .onAppear { name = project?.name ?? ""; color = project?.color ?? "#2563eb" }
            .confirmationDialog("Delete this project? Its tasks will move to Inbox.", isPresented: $confirmDelete) {
                Button("Delete project", role: .destructive) { if let project { Task { await store.perform {
                    try await store.api.send("/api/v1/projects/\(project.id)", method: "DELETE")
                    try await store.refresh(); dismiss()
                } } } }
            }
    }
}
struct SettingsView: View {
    @ObservedObject private var notifications = Notifications.shared
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) var dismiss
    @State private var tokenName = ""
    @State private var newToken = ""
    @State private var tokens: [PersonalToken] = []
    @State private var sessions: [DeviceSession] = []
    @State private var confirmation = ""
    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    Text(store.profile?.email ?? "")
                    Text(store.server).font(.caption).foregroundStyle(.secondary)
                    Button("Sign out") { Task { await store.perform { try await store.signOut(); dismiss() } } }
                    // Best effort on the server. Unregistering below makes APNs retire this device's token anyway.
                    Button("Remove local session") { Task { await store.perform { try? await notifications.disable(); try store.forgetSession(); dismiss() } } }
                }
                Section("Reminders & notifications") {
                    Text("Set a due time and reminder on a task, then enable notifications on each device.").font(.caption)
                    Button("Enable notifications") { Task { await store.perform { try await notifications.enable() } } }
                    Button("Disable on this device") { Task { await store.perform { try await notifications.disable() } } }
                    if !notifications.status.isEmpty { Text(notifications.status).font(.caption) }
                }
                Section("Signed-in devices") {
                    ForEach(sessions) { session in
                        HStack {
                            Text(session.current ? "This device" : session.kind == "web" ? "Browser" : "Apple app")
                            Spacer()
                            if !session.current {
                                Button("End session", role: .destructive) { Task { await store.perform {
                                    try await store.api.send("/api/v1/sessions/\(session.id)", method: "DELETE")
                                    try await loadSessions()
                                } } }
                            }
                        }
                    }
                }
                Section("API & MCP access") {
                    Text("Tokens expire after 90 days. Keep them private.").font(.caption)
                    TextField("Token name", text: $tokenName)
                    Button("Create token") { Task { await store.perform {
                        let result: CreatedToken = try await store.api.request("/api/v1/tokens", method: "POST", body: API.body(["name": tokenName]))
                        newToken = result.token; tokenName = ""
                        try await loadTokens()
                    } } }.disabled(tokenName.isEmpty || store.busy)
                    if !newToken.isEmpty {
                        Text("Copy now. This token is only shown once.").font(.caption)
                        Text(newToken).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        ShareLink("Copy or share token securely", item: newToken)
                    }
                    ForEach(tokens) { token in
                        HStack { Text(token.name); Spacer(); Button("Revoke", role: .destructive) { Task { await store.perform {
                            try await store.api.send("/api/v1/tokens/\(token.id)", method: "DELETE")
                            try await loadTokens()
                        } } } }
                    }
                }
                Section("Delete account") {
                    Text("Permanently remove all tasks, projects, credentials, and Apple authorization. Type DELETE to confirm.").font(.caption)
                    TextField("Confirmation", text: $confirmation)
                    Button("Delete my account", role: .destructive) { Task { await store.perform { try await store.deleteAccount(); dismiss() } } }.disabled(confirmation != "DELETE" || store.busy)
                }
            }.formStyle(.grouped).navigationTitle("Your workspace")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.frame(idealWidth: 530, idealHeight: 600)
            .tasksErrorAlert()
            .task { do { try await loadTokens(); try await loadSessions() } catch { store.report(error) } }
    }
    func loadTokens() async throws { tokens = try await store.api.request("/api/v1/tokens") }
    func loadSessions() async throws { sessions = try await store.api.request("/api/v1/sessions") }
}
