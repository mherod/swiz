import AppKit
import UserNotifications

@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    private var continuation: CheckedContinuation<String?, Never>?

    override private init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    func deliver(args: NotifyArgs) async -> ExitCode {
        // Always register a category so macOS can route banner clicks back to this process.
        // Without a registered category the process exits before the user can interact,
        // causing an "app is not open" error when the notification is clicked.
        let hasActions = !args.actions.isEmpty || !args.textActions.isEmpty
        var allActions: [UNNotificationAction] = args.actions.map {
            UNNotificationAction(identifier: $0.identifier, title: $0.title, options: [.foreground])
        }
        for ta in args.textActions {
            allActions.append(UNTextInputNotificationAction(
                identifier: ta.identifier,
                title: ta.title,
                options: [.foreground],
                textInputButtonTitle: ta.title,
                textInputPlaceholder: ta.placeholder
            ))
        }
        let categoryId = args.categoryIdentifier.isEmpty
            ? (hasActions ? "swiz-actions" : "swiz-default")
            : args.categoryIdentifier
        let category = UNNotificationCategory(
            identifier: categoryId,
            actions: allActions,
            intentIdentifiers: [],
            options: hasActions ? [.customDismissAction] : []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])

        // Request authorization
        let granted = await requestAuthorization()
        guard granted else {
            fputs("swiz-notify: notification permission denied\n", stderr)
            return .permissionDenied
        }

        // Build content
        let content = UNMutableNotificationContent()
        content.title = args.title
        if !args.subtitle.isEmpty { content.subtitle = args.subtitle }
        if !args.body.isEmpty { content.body = args.body }
        if args.sound != "none" {
            content.sound = args.sound == "default"
                ? .default
                : UNNotificationSound(named: UNNotificationSoundName(args.sound))
        }
        content.categoryIdentifier = categoryId

        // Attach image if provided
        if !args.imageURL.isEmpty {
            let url = URL(fileURLWithPath: args.imageURL)
            if let attachment = try? UNNotificationAttachment(identifier: "image", url: url) {
                content.attachments = [attachment]
            }
        }

        let request = UNNotificationRequest(
            identifier: args.identifier,
            content: content,
            trigger: nil  // deliver immediately
        )

        do {
            try await UNUserNotificationCenter.current().add(request)
        } catch {
            fputs("swiz-notify: failed to deliver notification: \(error)\n", stderr)
            return .deliveryFailed
        }

        // Wait for user response or timeout — keeping the process alive until the banner
        // is dismissed or clicked ensures macOS can route interactions back here.
        let result = await withTimeout(seconds: args.timeout) {
            await self.waitForResponse()
        }
        if hasActions, let output = result {
            fputs("\(output)\n", stdout)  // stdout: "id" or "id:userText"
        }

        return .success
    }

    private func requestAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .authorized { return true }

        do {
            return try await center.requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            return false
        }
    }

    private func waitForResponse() async -> String? {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let actionIdentifier = response.actionIdentifier
        // For text-input actions, append ":userText" so callers can parse the reply
        let output: String?
        if actionIdentifier == UNNotificationDefaultActionIdentifier || actionIdentifier == UNNotificationDismissActionIdentifier {
            output = nil
        } else if let textResponse = response as? UNTextInputNotificationResponse {
            let text = textResponse.userText.trimmingCharacters(in: .whitespacesAndNewlines)
            output = text.isEmpty ? actionIdentifier : "\(actionIdentifier):\(text)"
        } else {
            output = actionIdentifier
        }
        Task { @MainActor in
            self.continuation?.resume(returning: output)
            self.continuation = nil
        }
        completionHandler()
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }
}

enum ExitCode: Int32 {
    case success = 0
    case badArgs = 1
    case permissionDenied = 2
    case deliveryFailed = 3
}

func withTimeout<T: Sendable>(seconds: Double, operation: @escaping @Sendable () async -> T?) async -> T? {
    await withTaskGroup(of: T?.self) { group in
        group.addTask { await operation() }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            return nil
        }
        let result = await group.next()
        group.cancelAll()
        return result ?? nil
    }
}
