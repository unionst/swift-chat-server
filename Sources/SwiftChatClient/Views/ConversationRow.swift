import SwiftChat
import SwiftUI

public struct ConversationRow: View {
    let client: ChatClient
    let conversation: Conversation

    public init(client: ChatClient, conversation: Conversation) {
        self.client = client
        self.conversation = conversation
    }

    public var body: some View {
        let others = conversation.others(than: client.me?.id)
        ChatConversationRow(
            name: client.title(of: conversation),
            date: conversation.lastMessage?.createdAt ?? conversation.lastMessageAt,
            isUnread: conversation.unread > 0
        ) { size in
            if let url = conversation.photoURL {
                ChatUserAvatar(user: ChatUser(id: conversation.id, externalID: conversation.id, name: conversation.name, avatarURL: url), size: size)
            } else if others.count > 1 {
                ChatGroupAvatar(roles: others.map { ChatRole.user(id: $0.user.id, displayName: $0.user.displayName) }, size: size)
            } else {
                ChatUserAvatar(user: others.first?.user ?? client.me, size: size)
            }
        } subtitle: {
            ChatMessagePreview(message: preview)
        } accessory: {
            EmptyView()
        }
    }

    private var preview: String {
        guard let last = conversation.lastMessage else { return "" }
        if conversation.direct || last.senderID == client.me?.id || last.isSystem { return last.preview }
        return "\(client.user(last.senderID ?? "")?.displayName ?? "Someone"): \(last.preview)"
    }
}
