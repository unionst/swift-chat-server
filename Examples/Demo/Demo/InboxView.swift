import SwiftChat
import SwiftChatClient
import SwiftUI

struct InboxView: View {
    let client: ChatClient
    @State private var path: [String] = []
    @State private var composing = false

    var body: some View {
        NavigationStack(path: $path) {
            List(client.conversations) { conversation in
                NavigationLink(value: conversation.id) {
                    ConversationRow(client: client, conversation: conversation)
                }
                .chatConversationRowInsets()
            }
            .listStyle(.plain)
            .navigationTitle("Messages")
            .navigationDestination(for: String.self) { id in
                ThreadView(client: client, conversationID: id)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New Message", systemImage: "square.and.pencil") { composing = true }
                }
            }
            .sheet(isPresented: $composing) {
                NewConversationView(client: client) { conversation in
                    composing = false
                    path = [conversation.id]
                }
            }
            .overlay {
                if client.conversations.isEmpty, client.hasLoadedOnce {
                    ContentUnavailableView("No Messages", systemImage: "bubble.left.and.bubble.right", description: Text("Tap the compose button to start a conversation."))
                }
            }
            .task {
                guard let peer = DemoLaunch.openPeer, path.isEmpty else { return }
                if let conversation = try? await client.startConversation(externalIDs: [peer]) {
                    path = [conversation.id]
                }
            }
        }
    }
}
