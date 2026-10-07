import SwiftChatClient
import SwiftUI

@main
struct DemoApp: App {
    @State private var client = ChatClient(baseURL: URL(string: "https://swift-chat-server.vercel.app")!)

    var body: some Scene {
        WindowGroup {
            RootView(client: client)
        }
    }
}
