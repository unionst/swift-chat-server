import SwiftChat
import SwiftUI

public struct ConversationView: View {
    let client: ChatClient
    let conversationID: String

    public init(client: ChatClient, conversationID: String) {
        self.client = client
        self.conversationID = conversationID
    }

    public var body: some View {
        let conversation = client.conversation(conversationID)
        let lastOutgoing = client.lastOutgoingID(in: conversationID)
        Chat(client.messages(in: conversationID), typingUsers: client.typingRoles(in: conversationID)) { message in
            client.transcriptRow(for: message, lastOutgoingID: lastOutgoing, in: conversation)
        }
        .chatAvatar { role in
            ChatUserAvatar(user: client.user(for: role))
        }
        .chatInputCapabilities([.photoLibrary, .files])
        .chatLoadsOlderMessages { await client.loadOlder(in: conversationID) }
        .chatMessageContextMenu { (id: String) in
            client.contextMenuItems(for: id, in: conversationID)
        }
        .onChatSend { text, media in
            await client.send(text: text, media: media, in: conversationID)
        }
        .onChatTypingChanged { isTyping in
            Task { @MainActor in client.setTyping(isTyping, in: conversationID) }
        }
        .task(id: conversationID) {
            await client.open(conversationID)
        }
        .onDisappear {
            client.close(conversationID)
        }
    }
}
