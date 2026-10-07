import SwiftChatClient
import SwiftUI

struct ThreadView: View {
    let client: ChatClient
    let conversationID: String

    var body: some View {
        ConversationView(client: client, conversationID: conversationID)
            .navigationTitle(client.conversation(conversationID).map(client.title(of:)) ?? "")
            .navigationBarTitleDisplayMode(.inline)
    }
}
