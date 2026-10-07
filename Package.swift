// swift-tools-version:6.1

import PackageDescription

let package = Package(
    name: "swift-chat-server",
    platforms: [
        .iOS(.v18)
    ],
    products: [
        .library(
            name: "SwiftChatClient",
            targets: ["SwiftChatClient"])
    ],
    dependencies: [
        .package(url: "https://github.com/unionst/swift-chat.git", from: "1.0.7")
    ],
    targets: [
        .target(
            name: "SwiftChatClient",
            dependencies: [
                .product(name: "SwiftChat", package: "swift-chat")
            ],
            path: "Sources/SwiftChatClient"
        )
    ]
)
