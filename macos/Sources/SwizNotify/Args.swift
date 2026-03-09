import Foundation

struct NotifyArgs {
    var title: String = ""
    var subtitle: String = ""
    var body: String = ""
    var sound: String = "default"
    var identifier: String = UUID().uuidString
    var categoryIdentifier: String = ""
    var imageURL: String = ""
    var timeout: Double = 10.0
    var actions: [Action] = []
    /// Path to append JSONL feedback entries when an action is tapped.
    /// Defaults to ~/.swiz/notification-feedback.jsonl when non-empty.
    var feedbackFile: String = ""
    /// The working directory of the session that sent this notification.
    /// Written into JSONL feedback entries so the receiving session can filter by project.
    var targetCwd: String = ""

    struct Action {
        let identifier: String
        let title: String
    }

    /// A text-input action: user types a reply directly inside the notification.
    /// The binary outputs "\(identifier):\(userText)" to stdout when submitted.
    struct TextAction {
        let identifier: String
        let title: String
        let placeholder: String
    }

    var textActions: [TextAction] = []
}

enum ArgError: Error, CustomStringConvertible {
    case missingValue(String)
    case unknownFlag(String)
    case missingTitle

    var description: String {
        switch self {
        case .missingValue(let flag): return "Flag \(flag) requires a value"
        case .unknownFlag(let flag): return "Unknown flag: \(flag)"
        case .missingTitle: return "--title is required"
        }
    }
}

func parseArgs(_ args: [String]) throws -> NotifyArgs {
    var result = NotifyArgs()
    var i = args.startIndex

    while i < args.endIndex {
        let arg = args[i]
        switch arg {
        case "--title":
            i = args.index(after: i)
            guard i < args.endIndex else { throw ArgError.missingValue("--title") }
            result.title = args[i]
        case "--subtitle":
            i = args.index(after: i)
            guard i < args.endIndex else { throw ArgError.missingValue("--subtitle") }
            result.subtitle = args[i]
        case "--body", "--message":
            i = args.index(after: i)
            guard i < args.endIndex else { throw ArgError.missingValue(arg) }
            result.body = args[i]
        case "--sound":
            i = args.index(after: i)
            guard i < args.endIndex else { throw ArgError.missingValue("--sound") }
            result.sound = args[i]
        case "--identifier":
            i = args.index(after: i)
            guard i < args.endIndex else { throw ArgError.missingValue("--identifier") }
            result.identifier = args[i]
        case "--category":
            i = args.index(after: i)
            guard i < args.endIndex else { throw ArgError.missingValue("--category") }
            result.categoryIdentifier = args[i]
        case "--image":
            i = args.index(after: i)
            guard i < args.endIndex else { throw ArgError.missingValue("--image") }
            result.imageURL = args[i]
        case "--timeout":
            i = args.index(after: i)
            guard i < args.endIndex else { throw ArgError.missingValue("--timeout") }
            result.timeout = Double(args[i]) ?? 10.0
        case "--action":
            // --action <id> <title>
            i = args.index(after: i)
            guard i < args.endIndex else { throw ArgError.missingValue("--action id") }
            let actionId = args[i]
            i = args.index(after: i)
            guard i < args.endIndex else { throw ArgError.missingValue("--action title") }
            let actionTitle = args[i]
            result.actions.append(.init(identifier: actionId, title: actionTitle))
        case "--text-action":
            // --text-action <id> <title> <placeholder>
            i = args.index(after: i)
            guard i < args.endIndex else { throw ArgError.missingValue("--text-action id") }
            let taId = args[i]
            i = args.index(after: i)
            guard i < args.endIndex else { throw ArgError.missingValue("--text-action title") }
            let taTitle = args[i]
            i = args.index(after: i)
            guard i < args.endIndex else { throw ArgError.missingValue("--text-action placeholder") }
            let taPlaceholder = args[i]
            result.textActions.append(.init(identifier: taId, title: taTitle, placeholder: taPlaceholder))
        case "--feedback-file":
            i = args.index(after: i)
            guard i < args.endIndex else { throw ArgError.missingValue("--feedback-file") }
            result.feedbackFile = args[i]
        case "--target-cwd":
            i = args.index(after: i)
            guard i < args.endIndex else { throw ArgError.missingValue("--target-cwd") }
            result.targetCwd = args[i]
        default:
            if arg.hasPrefix("-") {
                throw ArgError.unknownFlag(arg)
            }
        }
        i = args.index(after: i)
    }

    if result.title.isEmpty {
        throw ArgError.missingTitle
    }

    return result
}
