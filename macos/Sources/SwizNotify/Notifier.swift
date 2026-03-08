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
        // Register action categories if requested
        if !args.actions.isEmpty {
            let actions = args.actions.map {
                UNNotificationAction(
                    identifier: $0.identifier,
                    title: $0.title,
                    options: [.foreground]
                )
            }
            let category = UNNotificationCategory(
                identifier: args.categoryIdentifier.isEmpty ? "swiz-actions" : args.categoryIdentifier,
                actions: actions,
                intentIdentifiers: [],
                options: [.customDismissAction]
            )
            UNUserNotificationCenter.current().setNotificationCategories([category])
        }

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
        if !args.actions.isEmpty {
            content.categoryIdentifier = args.categoryIdentifier.isEmpty ? "swiz-actions" : args.categoryIdentifier
        }

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

        // Wait for user response (if actions registered) or timeout
        if !args.actions.isEmpty {
            let actionId = await withTimeout(seconds: args.timeout) {
                await self.waitForResponse()
            }
            if let id = actionId {
                print(id)  // stdout: the chosen action identifier
            }
        } else {
            // Brief wait to ensure delivery before exit
            try? await Task.sleep(nanoseconds: 500_000_000)
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
        Task { @MainActor in
            self.continuation?.resume(returning: actionIdentifier == UNNotificationDefaultActionIdentifier ? nil : actionIdentifier)
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
