import AppIntents
import UserNotifications

/// Tags each pushed task reminder with its App Intents entity, so Siri can complete or snooze it,
/// for example when announcing the notification. The server sets mutable-content on task notifications.
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        if let id = content.userInfo["task_id"] as? String {
            content.appEntityIdentifiers = [EntityIdentifier(for: TaskEntity.self, identifier: id)]
        }
        contentHandler(content)
    }
}
