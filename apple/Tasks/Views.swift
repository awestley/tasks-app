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
    /// What `checkedServer` offers. Editing the URL hides it, so the buttons always describe the server in the field.
    @State private var config: AuthConfig?
    @State private var checkedServer: String?
    @State private var checking = false
    @State private var challenge: AppleChallenge?
    @State private var loadingChallenge = false
    @Environment(\.colorScheme) private var colorScheme
    #if DEBUG
    @State private var developmentToken = ""
    @State private var showDevelopment = false
    #endif
    private var methods: AuthConfig? { checkedServer == Store.origin(server) ? config : nil }
    var body: some View {
        // No scroll view: one that is still settling after the field scrolls into view swallows the next tap.
        // On iPhone the card stays at the top, so the field does not move as the keyboard and messages come and go.
        card.frame(maxWidth: 380)
            #if os(iOS)
            .padding(.horizontal, 16).padding(.top, 40).padding(.bottom, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            #else
            .padding(.horizontal, 16).padding(.vertical, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            #endif
            .background(Glassive.backgroundSecondary)
        .task {
            server = store.server
            // Offer the saved server's sign-in methods right away. A new server waits for Continue.
            if store.serverSaved { await check() }
        }
    }
    private var card: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Sign in").font(.title2.weight(.semibold))
            VStack(alignment: .leading, spacing: 6) {
                Text("Server").font(.subheadline.weight(.medium)).foregroundStyle(Color.primary).accessibilityHidden(true)
                TextField("Your server URL", text: $server, prompt: Text(verbatim: "https://tasks.example.com"))
                    .labelsHidden()
                    // Hiding the label also removes it from VoiceOver, which would then read only the example URL.
                    .accessibilityLabel("Your server URL")
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .submitLabel(.continue)
                    #endif
                    .onSubmit { Task { await check(fromPerson: true) } }
                    .onChange(of: server) { old, _ in
                        // The first change fills in the saved server and keeps a message such as an ended session.
                        if !old.isEmpty, store.error != nil { store.error = nil }
                    }
            }
            if let methods { signInMethods(methods) } else {
                Button { Task { await check(fromPerson: true) } } label: {
                    Text(checking ? "Checking..." : "Continue").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).controlSize(.large)
                .disabled(checking || Store.origin(server).isEmpty)
            }
            if let error = store.error {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "exclamationmark.circle").accessibilityHidden(true)
                    Text(error).accessibilityIdentifier("signInError").fixedSize(horizontal: false, vertical: true)
                }.font(.callout).foregroundStyle(Glassive.red)
            }
            #if DEBUG
            DisclosureGroup("Local development", isExpanded: $showDevelopment) {
                VStack(alignment: .leading, spacing: 8) {
                    SecureField("Personal access token from the web app", text: $developmentToken).textFieldStyle(.roundedBorder)
                    Button("Use development token") {
                        store.error = nil
                        Task { await store.perform {
                            try store.connect(server: server)
                            try Keychain.save(developmentToken, server: store.server)
                            try await store.refresh()
                            developmentToken = ""
                        } }
                    }.disabled(developmentToken.isEmpty || store.busy)
                }.padding(.top, 8)
            }.font(.caption).padding(.top, 4)
            #endif
        }
        .padding(32)
        .background(Glassive.backgroundPrimary, in: RoundedRectangle(cornerRadius: Glassive.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Glassive.cardRadius, style: .continuous).stroke(Glassive.border))
        .shadow(color: .black.opacity(0.14), radius: 24, y: 12)
    }
    /// Matches the web sign-in: Apple when configured, the local workspace on a development server, otherwise a note.
    @ViewBuilder private func signInMethods(_ methods: AuthConfig) -> some View {
        if methods.apple_enabled {
            if let challenge {
                SignInWithAppleButton(.signIn) { request in
                    request.requestedScopes = [.email, .fullName]
                    request.nonce = challenge.nonce
                } onCompletion: { result in
                    Task { await finishApple(result, challenge: challenge) }
                }
                .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                .frame(height: 44).clipShape(Capsule())
                .disabled(store.busy)
            } else if loadingChallenge {
                ProgressView().frame(maxWidth: .infinity, minHeight: 44)
            } else {
                Button { Task { await loadChallenge() } } label: { Text("Try again").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.large)
            }
        }
        #if DEBUG
        if methods.dev_login {
            Button { Task { await openLocalWorkspace() } } label: {
                Text(store.busy ? "Opening..." : "Open local workspace").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).controlSize(.large).disabled(store.busy)
        }
        #endif
        if !methods.apple_enabled {
            Text("Apple sign-in is not configured.").font(.callout).foregroundStyle(Color.secondary)
        }
    }
    /// Asks the server in the field which sign-in methods it offers.
    func check(fromPerson: Bool = false) async {
        let requested = Store.origin(server)
        guard !requested.isEmpty, !checking else { return }
        if fromPerson { store.error = nil }
        checking = true
        defer { checking = false }
        do {
            try store.connect(server: requested)
            let result: AuthConfig = try await store.api.request("/auth/config")
            // The person may have typed another server while this one answered.
            guard Store.origin(server) == requested else { return }
            config = result
            checkedServer = requested
            if result.apple_enabled { await loadChallenge() }
        } catch {
            if Store.origin(server) == requested { store.error = error.localizedDescription }
        }
    }
    /// A challenge is single-use and expires after ten minutes, so each Apple attempt gets a fresh one.
    func loadChallenge() async {
        let requested = store.server
        challenge = nil
        loadingChallenge = true
        defer { loadingChallenge = false }
        do {
            let result: AppleChallenge = try await store.api.request("/auth/apple/challenge", method: "POST", body: API.body(["client_id": Bundle.main.bundleIdentifier ?? ""]))
            if checkedServer == requested { challenge = result }
        } catch { store.error = error.localizedDescription }
    }
    func finishApple(_ result: Result<ASAuthorization, Error>, challenge used: AppleChallenge) async {
        if case .failure(let error) = result {
            // Closing Apple's sheet is a choice, not an error, and leaves the challenge unused.
            guard (error as? ASAuthorizationError)?.code != .canceled else { return }
            store.error = "Apple sign-in did not finish. Please try again."
            return
        }
        store.error = nil
        await store.perform {
            guard case .success(let authorization) = result,
                  let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let data = credential.authorizationCode,
                  let code = String(data: data, encoding: .utf8) else {
                throw APIError(message: "Apple did not return an authorization code.")
            }
            try await store.signIn(code: code, challenge: used.challenge_id)
        }
        // The server consumed the challenge, so a retry needs a new one.
        if store.profile == nil { await loadChallenge() }
    }
    func openLocalWorkspace() async {
        store.error = nil
        await store.perform { try await store.signInLocally() }
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
                    ToolbarItem { Button { showSettings = true } label: { Image(systemName: "gearshape") }.help("Settings").accessibilityLabel("Settings") }
                }
        } detail: {
            VStack(alignment: .leading, spacing: 0) {
                if selection == "today", search.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(Date(), format: .dateTime.weekday(.wide).month(.wide).day()).font(.subheadline).foregroundStyle(Color.secondary)
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
                                        Text(task.title).font(.body).strikethrough(task.completed).foregroundStyle(task.completed ? Color.secondary : Color.primary)
                                        if !task.description.isEmpty { Text(task.description).font(.caption).foregroundStyle(Color.secondary).lineLimit(1) }
                                        HStack(spacing: 8) {
                                            if let due = task.due_date {
                                                Label(DateOnly.date(due).formatted(date: .abbreviated, time: .omitted), systemImage: task.recurrence == nil ? "calendar" : "repeat")
                                                    .foregroundStyle(due < today && !task.completed ? Glassive.red : due == today ? Glassive.textAccent : Color.secondary)
                                            }
                                            if let time = task.due_time { Text("\(time) \(task.time_zone)").foregroundStyle(Color.secondary) }
                                            if task.reminder_minutes != nil {
                                                Image(systemName: task.isAlarm ? "alarm" : "bell").accessibilityLabel(task.isAlarm ? "Alarm set" : "Reminder set")
                                            }
                                            if let snoozed = task.snoozedInstant, snoozed > Date() {
                                                Label(snoozed.formatted(date: .omitted, time: .shortened), systemImage: "zzz")
                                                    .foregroundStyle(Color.secondary).accessibilityLabel("Snoozed until \(snoozed.formatted(date: .omitted, time: .shortened))")
                                            }
                                            if !task.checklist.isEmpty {
                                                Label("\(task.checklist.filter { $0.completed }.count)/\(task.checklist.count)", systemImage: "checklist")
                                                    .foregroundStyle(Color.secondary)
                                                    .accessibilityLabel("\(task.checklist.filter { $0.completed }.count) of \(task.checklist.count) checklist items completed")
                                            }
                                            if !task.labels.isEmpty { Label(task.labels.joined(separator: " "), systemImage: "tag").foregroundStyle(Color.secondary) }
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
        .onChange(of: notifications.settingsRequested, initial: true) { _, requested in
            guard requested else { return }
            showSettings = true
            notifications.settingsRequested = false
        }
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
        let options = [(Self.day(0), "Today", "calendar", Color.secondary), (Self.day(1), "Tomorrow", "sunrise", Color.secondary),
                       (Self.day(weekday == 1 ? 0 : 7 - weekday), "This weekend", "sofa", Color.secondary),
                       (Self.day((9 - weekday) % 7 == 0 ? 7 : (9 - weekday) % 7), "Next week", "arrow.right.to.line", Color.secondary)]
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
        if !task.completed {
            Menu {
                Button("15 minutes") { Task { await store.snooze(task, minutes: 15) } }
                Button("1 hour") { Task { await store.snooze(task, minutes: 60) } }
                Button("3 hours") { Task { await store.snooze(task, minutes: 180) } }
                Button("Tomorrow 09:00") { Task { await store.snooze(task, until: TaskActions.tomorrowMorning()) } }
            } label: { Label("Snooze", systemImage: "zzz") }
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
    @State private var alarmDenied = false
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
    func load(_ task: TodoTask) {
        draft = TaskDraft(title: task.title, description: task.description, project_id: task.project_id, due_date: task.due_date, due_time: task.due_time, time_zone: task.time_zone, reminder_minutes: task.reminder_minutes, priority: task.priority, labels: task.labels, checklist: task.checklist, recurrence: task.recurrence, alert_style: task.alert_style ?? "notification", version: task.version)
        labels = task.labels.joined(separator: ", ")
        loadTime(task.due_time)
        hasDate = task.due_date != nil
        date = task.due_date.map(DateOnly.date) ?? Date()
    }
    /// Shows the agent's changes in the editor, so the next save uses the new version.
    func agentChanged() {
        Task {
            try? await store.refresh()
            if let latest = store.tasks.first(where: { $0.id == task?.id }) { load(latest) }
        }
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
                Toggle("Detect dates, times and details", isOn: $smart).tint(Glassive.green)
                if parsing { ProgressView("Reading details...") }
                if !parseError.isEmpty { Text(parseError + " Turn off detail detection to enter fields manually.").foregroundStyle(Glassive.red) }
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
                        Text("Reopen this task to change its checklist.").font(.caption).foregroundStyle(Color.secondary)
                    } else {
                        Button { draft.checklist.append(ChecklistItem()) } label: { Label("Add item", systemImage: "plus") }
                            .disabled(draft.checklist.count >= 100)
                    }
                }
                if let task {
                    LinksSection(owner: "/api/v1/tasks/\(task.id)")
                    AgentSection(taskID: task.id, changed: agentChanged)
                }
                Section {
                Picker("Project", selection: $draft.project_id) {
                    Text("Inbox").tag(nil as String?)
                    ForEach(store.projects) { Text($0.name).tag(Optional($0.id)) }
                }
                Toggle("Due date", isOn: $hasDate).tint(Glassive.green)
                if hasDate {
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                    Toggle("Due time", isOn: $hasTime).tint(Glassive.green)
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
                        if draft.reminder_minutes != nil {
                            Picker("Alert", selection: $draft.alert_style) {
                                Text("Notification").tag("notification")
                                Text("Alarm on iPhone").tag("alarm")
                            }
                            .onChange(of: draft.alert_style) { _, style in
                                #if os(iOS)
                                guard style == "alarm" else { return }
                                Task { if !(await Alarms.shared.requestPermission()) { alarmDenied = true } }
                                #endif
                            }
                            #if os(iOS)
                            if alarmDenied && draft.alert_style == "alarm" {
                                Text("Alarms are off for this app in Settings. This device will show a notification instead.").font(.caption).foregroundStyle(Color.secondary)
                            }
                            #endif
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
                if let task { load(task) } else { smart = true; draft.project_id = initialProject; hasDate = initialDate != nil; date = initialDate ?? Date() }
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
                if let project { LinksSection(owner: "/api/v1/projects/\(project.id)") }
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
    @State private var preferences: NotificationPreferences?
    static func clock(_ value: String) -> Date {
        let parts = value.split(separator: ":").compactMap { Int($0) }
        return Calendar.current.date(bySettingHour: parts.first ?? 8, minute: parts.last ?? 0, second: 0, of: Date()) ?? Date()
    }
    /// Saves at once. The summary uses this device's time zone.
    func savePreferences(_ change: (inout NotificationPreferences) -> Void) {
        guard var next = preferences else { return }
        change(&next)
        next.summary_zone = TimeZone.current.identifier
        preferences = next
        Task { await store.perform {
            preferences = try await store.api.request("/api/v1/notifications/settings", method: "PUT", body: JSONEncoder().encode(next))
        } }
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    Text(store.profile?.email ?? "")
                    Text(store.server).font(.caption).foregroundStyle(Color.secondary)
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
                if let loaded = preferences {
                    Section {
                        Toggle("Morning summary", isOn: Binding(get: { loaded.summary_time != nil }, set: { on in
                            savePreferences { $0.summary_time = on ? "08:00" : nil }
                        })).tint(Glassive.green)
                        if let time = loaded.summary_time {
                            DatePicker("Summary time", selection: Binding(get: { Self.clock(time) }, set: { value in
                                savePreferences { $0.summary_time = value.formatted(.verbatim("\(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased)):\(minute: .twoDigits)", timeZone: .current, calendar: .current)) }
                            }), displayedComponents: .hourAndMinute)
                        }
                        Picker("Overdue follow-up", selection: Binding(get: { loaded.overdue_minutes ?? 0 }, set: { value in
                            savePreferences { $0.overdue_minutes = value == 0 ? nil : value }
                        })) {
                            Text("Off").tag(0)
                            Text("30 minutes after").tag(30)
                            Text("1 hour after").tag(60)
                            Text("2 hours after").tag(120)
                            Text("4 hours after").tag(240)
                        }
                        Picker("Time Sensitive", selection: Binding(get: { loaded.time_sensitive_priority }, set: { value in
                            savePreferences { $0.time_sensitive_priority = value }
                        })) {
                            Text("Urgent").tag(1)
                            Text("Urgent and high").tag(2)
                            Text("Off").tag(0)
                        }
                    } footer: {
                        Text("The summary lists tasks due today and overdue, and is not sent when there are none. Follow-ups apply to tasks with a reminder. Time Sensitive reminders can break through Focus.")
                    }
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
                    if let reference = URL(string: store.server + "/docs"), ["https", "http"].contains(reference.scheme ?? "") {
                        Link("API reference", destination: reference)
                    }
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
            .task {
                do {
                    preferences = try await store.api.request("/api/v1/notifications/settings")
                    try await loadTokens(); try await loadSessions()
                } catch { store.report(error) }
            }
    }
    func loadTokens() async throws { tokens = try await store.api.request("/api/v1/tokens") }
    func loadSessions() async throws { sessions = try await store.api.request("/api/v1/sessions") }
}
/// Asks the server's agent to work on the task, then shows what it changed. Hidden when the server has no agent.
struct AgentSection: View {
    @EnvironmentObject var store: Store
    let taskID: String
    /// Called when the agent finished changing the task.
    let changed: () -> Void
    @State private var availability: AgentAvailability?
    @State private var run: AgentRun?
    @State private var instruction = ""
    var body: some View {
        if let availability, availability.available {
            Section {
                TextField("Optional instruction", text: $instruction).disabled(run?.active == true)
                Button { start() } label: {
                    Label(run?.active == true ? "Working..." : "Flesh out", systemImage: "sparkles")
                }.disabled(run?.active == true)
                if let run, !run.active {
                    if let error = run.error { Text(error).foregroundStyle(.red) }
                    if !run.summary.isEmpty { Text(run.summary) }
                    if !run.actions.isEmpty {
                        DisclosureGroup("\(run.actions.count) steps") {
                            ForEach(Array(run.actions.enumerated()), id: \.offset) { _, action in
                                Text("\(action.server): \(action.tool)").foregroundStyle(action.ok ? Color.secondary : Color.red)
                            }
                        }
                    }
                }
            } header: {
                Text("Flesh out")
            } footer: {
                if !availability.servers.isEmpty { Text("Uses \(availability.servers.joined(separator: ", "))") }
            }
        } else {
            EmptyView().task(id: taskID) { await load() }
        }
    }
    func load() async {
        guard let value: AgentAvailability = try? await store.api.request("/api/v1/agent"), value.available else { return }
        let runs: [AgentRun] = (try? await store.api.request("/api/v1/tasks/\(taskID)/agent-runs")) ?? []
        run = runs.first
        availability = value
        if run?.active == true { await follow() }
    }
    func start() {
        let text = instruction.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                run = try await store.api.request("/api/v1/tasks/\(taskID)/agent-runs", method: "POST", body: API.body(["instruction": text]))
                instruction = ""
                await follow()
            } catch { store.report(error) }
        }
    }
    /// Polls until the run ends. Stops when the editor closes, because the view's tasks are cancelled.
    func follow() async {
        while let current = run, current.active, !Task.isCancelled {
            try? await Task.sleep(for: .seconds(2))
            guard let next: AgentRun = try? await store.api.request("/api/v1/agent-runs/\(current.id)") else { continue }
            run = next
            if next.status == "done" { changed() }
        }
    }
}
/// Links save as soon as they are added or removed, separately from the task's other fields.
struct LinksSection: View {
    @EnvironmentObject var store: Store
    /// The owner's API path, such as /api/v1/tasks/<id>.
    let owner: String
    @State private var links: [ItemLink] = []
    @State private var target = ""
    @State private var title = ""
    var body: some View {
        Section("Links") {
            ForEach(links) { link in
                HStack {
                    if let address = link.url, let url = URL(string: address) {
                        Link(destination: url) { Label(link.title, systemImage: "link") }
                    } else {
                        Label(link.title, systemImage: "link").help(link.ref ?? "")
                    }
                    Spacer()
                    Button(role: .destructive) { remove(link) } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).accessibilityLabel("Remove link \(link.title)")
                }
            }
            TextField("Note or web address", text: $target)
                .autocorrectionDisabled()
            TextField("Title", text: $title)
            Button { add() } label: { Label("Add link", systemImage: "plus") }
                .disabled(target.trimmingCharacters(in: .whitespaces).isEmpty || store.busy)
        }
        .task(id: owner) {
            do { links = try await store.api.request(owner + "/links") } catch { store.report(error) }
        }
    }
    func add() {
        let value = target.trimmingCharacters(in: .whitespaces)
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
