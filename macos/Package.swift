// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SwizNotify",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "swiz-notify", targets: ["SwizNotify"]),
    ],
    targets: [
        .executableTarget(
            name: "SwizNotify",
            path: "Sources/SwizNotify"
        ),
    ]
)
