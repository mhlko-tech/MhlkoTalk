package com.mhlko.talk.data

enum class ConnectionStatus {
    Idle,
    Connecting,
    Connected,
    Recovering,
    Failed,
}

enum class ShareQuality { Low, Medium, High }

data class UserProfile(
    val name: String = "Me",
    val bio: String = "",
    val avatar: String = "",
)

data class MemberUi(
    val identity: String,
    val name: String,
    val speaking: Boolean,
    val microphoneEnabled: Boolean,
    val cameraEnabled: Boolean,
    val screenShareEnabled: Boolean,
    val bio: String = "",
    val avatar: String = "",
    val userVolume: Int = 100,
    val streamVolume: Int = 100,
)

data class ChatMessageUi(
    val id: String,
    val sender: String,
    val senderIdentity: String? = null,
    val body: String,
    val createdAt: Long,
    val mine: Boolean,
    val deleted: Boolean = false,
    val replyToId: String? = null,
    val replyToSender: String? = null,
    val replyToBody: String? = null,
    val attachment: AttachmentUi? = null,
)

data class AttachmentUi(
    val uri: String,
    val name: String,
    val mimeType: String,
    val size: Long,
    val progress: Float = 1f,
    val sending: Boolean = false,
)

data class SessionUiState(
    val termsAccepted: Boolean = false,
    val status: ConnectionStatus = ConnectionStatus.Idle,
    val roomName: String? = null,
    val microphoneEnabled: Boolean = true,
    val cameraEnabled: Boolean = false,
    val screenShareEnabled: Boolean = false,
    val localSpeaking: Boolean = false,
    val members: List<MemberUi> = emptyList(),
    val messages: List<ChatMessageUi> = emptyList(),
    val typingNames: List<String> = emptyList(),
    val mainActiveCount: Int = 0,
    val privateCode: String? = null,
    val error: String? = null,
    val notice: String? = null,
    val localProfile: UserProfile = UserProfile(),
    val outputLevel: Int = 100,
    val isRecordingVoice: Boolean = false,
    val messageSoundsEnabled: Boolean = true,
    val cameraSoundsEnabled: Boolean = true,
    val screenShareSoundsEnabled: Boolean = true,
    val screenSharePrivacyEnabled: Boolean = true,
    val launchReady: Boolean = false,
    val updateVersion: String? = null,
)
