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

    struct Action {
        let identifier: String
        let title: String
    }
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
