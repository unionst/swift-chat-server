import SwiftChatClient
import SwiftUI

struct NewConversationView: View {
    let client: ChatClient
    let onStarted: (Conversation) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [ChatUser] = []

    var body: some View {
        NavigationStack {
            List(results) { user in
                Button {
                    Task {
                        if let conversation = try? await client.startConversation(with: [user.id]) {
                            onStarted(conversation)
                        }
                    }
                } label: {
                    HStack {
                        ChatUserAvatar(user: user, size: 40)
                        Text(user.displayName)
                    }
                }
            }
            .listStyle(.plain)
            .searchable(text: $query, prompt: "Search people")
            .task(id: query) {
                results = (try? await client.searchUsers(query)) ?? []
            }
            .navigationTitle("New Message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .close) { dismiss() }
                }
            }
        }
    }
}
