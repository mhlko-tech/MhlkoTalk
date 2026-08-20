package com.mhlko.talk.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.ClipData
import android.content.ClipboardManager
import android.media.projection.MediaProjectionManager
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.graphics.BitmapFactory
import android.os.Build
import android.net.Uri
import android.widget.MediaController
import android.widget.VideoView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.ui.viewinterop.AndroidView
import com.mhlko.talk.call.SessionViewModel
import com.mhlko.talk.data.ConnectionStatus
import com.mhlko.talk.data.MemberUi
import com.mhlko.talk.data.SessionUiState
import com.mhlko.talk.data.UserProfile
import com.mhlko.talk.data.ChatMessageUi
import com.mhlko.talk.ui.theme.*
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import io.livekit.android.renderer.SurfaceViewRenderer
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay

@Composable
fun MHTalkApp(session: SessionViewModel = viewModel()) {
    val state by session.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var permissionAction by remember { mutableStateOf<(() -> Unit)?>(null) }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val audioAllowed = result[Manifest.permission.RECORD_AUDIO] == true ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (audioAllowed) permissionAction?.invoke()
        permissionAction = null
    }
    var cameraPermissionAction by remember { mutableStateOf<(() -> Unit)?>(null) }
    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { allowed ->
        if (allowed) cameraPermissionAction?.invoke()
        cameraPermissionAction = null
    }
    val screenShareLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            session.startScreenShare(result.data!!)
        }
    }
    fun withCallPermission(action: () -> Unit) {
        val missing = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) action() else {
            permissionAction = action
            permissionLauncher.launch(missing.toTypedArray())
        }
    }

    var privateSheet by remember { mutableStateOf(false) }
    var showProfile by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    var showHelp by remember { mutableStateOf(false) }
    var pendingProfilePhoto by remember { mutableStateOf<Uri?>(null) }
    val profilePhotoPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) pendingProfilePhoto = uri
    }
    var tab by remember { mutableIntStateOf(0) }
    Scaffold(
        containerColor = MHTalkBackground,
        bottomBar = {
            if (state.roomName != null) NavigationBar(containerColor = Color(0xFF101422)) {
                NavigationBarItem(tab == 0, { tab = 0 }, { Icon(Icons.Rounded.Tag, "Room") }, label = { Text("Room") })
                NavigationBarItem(tab == 1, { tab = 1 }, { Icon(Icons.Rounded.ChatBubble, "Chat") }, label = { Text("Chat") })
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            Header(
                state = state,
                onEditProfile = { showProfile = true },
                onSettings = { showSettings = true },
                onHelp = { showHelp = true },
                onReport = {
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://instagram.com/m.ed1t")))
                },
            )
            when {
                state.roomName == null -> RoomsHome(
                    state,
                    onMain = { withCallPermission(session::joinMain) },
                    onPrivate = { privateSheet = true },
                )
                tab == 0 -> ActiveRoom(
                    state,
                    session,
                    onCamera = {
                        if (state.cameraEnabled || ContextCompat.checkSelfPermission(
                                context,
                                Manifest.permission.CAMERA,
                            ) == PackageManager.PERMISSION_GRANTED
                        ) {
                            session.toggleCamera()
                        } else {
                            cameraPermissionAction = session::toggleCamera
                            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                        }
                    },
                    onScreenShare = {
                        if (state.screenShareEnabled) {
                            session.stopScreenShare()
                        } else {
                            val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                            screenShareLauncher.launch(manager.createScreenCaptureIntent())
                        }
                    },
                )
                else -> RoomChat(state, session)
            }
        }
    }

    if (privateSheet) PrivateRoomSheet(
        onDismiss = { privateSheet = false },
        onCreate = {
            privateSheet = false
            withCallPermission(session::createPrivate)
        },
        onJoin = { code ->
            privateSheet = false
            withCallPermission { session.joinPrivate(code) }
        },
    )
    if (showProfile) ProfileDialog(
        profile = state.localProfile,
        onDismiss = { showProfile = false },
        onSave = {
            session.saveProfile(it)
            showProfile = false
        },
        onChoosePhoto = { profilePhotoPicker.launch(arrayOf("image/*")) },
        onRemovePhoto = session::removeProfilePhoto,
    )
    if (showSettings) SettingsDialog(
        state = state,
        onDismiss = { showSettings = false },
        onOutput = session::setOutputLevel,
        onTestSpeaker = session::testSpeaker,
        onSwitchCamera = session::switchCamera,
    )
    if (showHelp) HelpDialog(onDismiss = { showHelp = false })
    pendingProfilePhoto?.let { uri ->
        ProfileCropDialog(
            uri = uri,
            onDismiss = { pendingProfilePhoto = null },
            onUse = { zoom, x, y ->
                session.chooseProfilePhoto(uri, zoom, x, y)
                pendingProfilePhoto = null
            },
        )
    }
    if (!state.termsAccepted) {
        AlertDialog(
            onDismissRequest = {},
            title = { Text("Welcome to MHTalk") },
            text = {
                LazyColumn(Modifier.heightIn(max = 470.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    item { Text("Please accept these rules before using rooms and chat.", fontWeight = FontWeight.Bold) }
                    item { Text("Be respectful. Harassment, threats, sexual exploitation, illegal content, malware, privacy violations and copyright infringement are prohibited.", color = MHTalkMuted) }
                    item { Text("MHTalk may process voice, video, screen share, profile details, messages and files only to provide realtime communication. LiveKit carries realtime media and the MHTalk service issues secure room access.", color = MHTalkMuted) }
                    item { Text("Public Main messages are filtered. You can long-press messages and open member profiles to report or block users. Reports are retained for up to 30 days for safety review.", color = MHTalkMuted) }
                    item { Text("By continuing, you agree to these Terms of Use and the Privacy Policy shown in Help.", color = MHTalkMuted) }
                }
            },
            confirmButton = { Button(session::acceptTerms) { Text("Accept and continue") } },
        )
    }
    state.privateCode?.let { code ->
        AlertDialog(
            onDismissRequest = session::clearPrivateCode,
            title = { Text("Private room created") },
            text = { Column { Text("Send this code to your friend:", color = MHTalkMuted); Text(code, color = MHTalkPurple, fontWeight = FontWeight.Black, fontSize = 24.sp) } },
            confirmButton = { TextButton(session::clearPrivateCode) { Text("Done") } },
        )
    }
    state.error?.let { error ->
        AlertDialog(
            onDismissRequest = session::dismissError,
            title = { Text("Could not connect") },
            text = { Text(error) },
            confirmButton = { TextButton(session::dismissError) { Text("OK") } },
        )
    }
    state.notice?.let { notice ->
        AlertDialog(
            onDismissRequest = session::dismissNotice,
            title = { Text("Done") },
            text = { Text(notice) },
            confirmButton = { TextButton(session::dismissNotice) { Text("OK") } },
        )
    }
}

@Composable
private fun Header(
    state: SessionUiState,
    onEditProfile: () -> Unit,
    onSettings: () -> Unit,
    onHelp: () -> Unit,
    onReport: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().background(MHTalkSurface).padding(horizontal = 18.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!isImageAvatar(state.localProfile.avatar)) {
            Box(Modifier.size(42.dp).clip(RoundedCornerShape(14.dp)).background(MHTalkPurple), contentAlignment = Alignment.Center) {
                Text(state.localProfile.avatar.take(2).ifBlank { "MH" }.uppercase(), color = Color.White, fontWeight = FontWeight.Black, fontSize = 13.sp)
            }
        } else {
            AsyncImage(
                model = state.localProfile.avatar,
                contentDescription = "Profile photo",
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(42.dp).clip(RoundedCornerShape(14.dp)),
            )
        }
        Column(Modifier.padding(start = 12.dp).weight(1f)) {
            Text(if (state.roomName == null) "MHTalk" else if (state.roomName == "Main") "Main channel" else "Private channel", fontWeight = FontWeight.ExtraBold, fontSize = 21.sp)
            Text(statusText(state.status), color = statusColor(state.status), fontSize = 12.sp)
        }
        Box {
            IconButton({ menuOpen = true }) { Icon(Icons.Rounded.MoreHoriz, "Profile and settings") }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text("Edit profile") },
                    leadingIcon = { Icon(Icons.Rounded.Person, null) },
                    onClick = { menuOpen = false; onEditProfile() },
                )
                DropdownMenuItem(
                    text = { Text("Settings") },
                    leadingIcon = { Icon(Icons.Rounded.Settings, null) },
                    onClick = { menuOpen = false; onSettings() },
                )
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text("Help") },
                    leadingIcon = { Icon(Icons.Rounded.HelpOutline, null) },
                    onClick = { menuOpen = false; onHelp() },
                )
                DropdownMenuItem(
                    text = { Text("Report a bug") },
                    leadingIcon = { Icon(Icons.Rounded.BugReport, null) },
                    onClick = { menuOpen = false; onReport() },
                )
            }
        }
    }
}

@Composable
private fun RoomsHome(state: SessionUiState, onMain: () -> Unit, onPrivate: () -> Unit) {
    Column(
        Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color(0xFF171A38), MHTalkBackground))).padding(18.dp),
    ) {
        Text("ROOMS", color = MHTalkMuted, fontWeight = FontWeight.Bold, fontSize = 12.sp)
        Spacer(Modifier.height(12.dp))
        RoomButton("Main channel", "${state.mainActiveCount} active", true, state.status == ConnectionStatus.Connecting, onMain)
        Spacer(Modifier.height(10.dp))
        RoomButton("Private channel", "Create or join with an invite code", false, false, onPrivate)
        Spacer(Modifier.weight(1f))
        Surface(color = Color(0xFF191E31), shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Rounded.Mic, null, tint = MHTalkPurple, modifier = Modifier.size(42.dp))
                Spacer(Modifier.height(14.dp))
                Text("Ready when you are", fontWeight = FontWeight.ExtraBold, fontSize = 22.sp)
                Text("Join Main or enter a private room.", color = MHTalkMuted)
            }
        }
        Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun RoomButton(title: String, subtitle: String, main: Boolean, busy: Boolean, onClick: () -> Unit) {
    Button(
        onClick, enabled = !busy, modifier = Modifier.fillMaxWidth().height(72.dp), shape = RoundedCornerShape(18.dp),
        colors = ButtonDefaults.buttonColors(containerColor = if (main) Color(0xFF34375B) else Color(0xFF20253A)),
    ) {
        Icon(if (main) Icons.Rounded.Tag else Icons.Rounded.Lock, null)
        Column(Modifier.padding(start = 13.dp).weight(1f), horizontalAlignment = Alignment.Start) {
            Text(title, fontWeight = FontWeight.Bold, fontSize = 16.sp)
            Text(subtitle, color = MHTalkMuted, fontSize = 12.sp)
        }
        if (busy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
        else Icon(Icons.Rounded.Add, null, tint = if (main) MHTalkGreen else MHTalkPurple)
    }
}

@Composable
private fun ActiveRoom(
    state: SessionUiState,
    session: SessionViewModel,
    onCamera: () -> Unit,
    onScreenShare: () -> Unit,
) {
    var selectedMember by remember { mutableStateOf<MemberUi?>(null) }
    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.weight(1f).padding(horizontal = 16.dp),
            contentPadding = PaddingValues(vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item {
                Text("IN THIS ROOM · ${state.members.size + 1}", color = MHTalkMuted, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                Spacer(Modifier.height(10.dp))
                MemberRow(
                    MemberUi(
                        "me",
                        state.localProfile.name,
                        state.localSpeaking,
                        state.microphoneEnabled,
                        state.cameraEnabled,
                        false,
                        state.localProfile.bio,
                        state.localProfile.avatar,
                    ),
                    true,
                    onClick = { selectedMember = it },
                )
                if (state.cameraEnabled) {
                    Spacer(Modifier.height(8.dp))
                    session.videoTrack(null, Track.Source.CAMERA)?.let { VideoTile(it, session, "Your camera") }
                }
                if (state.screenShareEnabled) {
                    Spacer(Modifier.height(8.dp))
                    session.videoTrack(null, Track.Source.SCREEN_SHARE)?.let { VideoTile(it, session, "Your screen") }
                }
            }
            items(state.members, key = { it.identity }) { member ->
                MemberRow(member, false, onClick = { selectedMember = it })
                if (member.cameraEnabled) {
                    session.videoTrack(member.identity, Track.Source.CAMERA)?.let { VideoTile(it, session, "${member.name}'s camera") }
                }
                if (member.screenShareEnabled) {
                    session.videoTrack(member.identity, Track.Source.SCREEN_SHARE)?.let { VideoTile(it, session, "${member.name}'s screen") }
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().background(Color(0xFF111522)).padding(12.dp).navigationBarsPadding(),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            Control(if (state.microphoneEnabled) Icons.Rounded.Mic else Icons.Rounded.MicOff, state.microphoneEnabled, false, session::toggleMicrophone, "Microphone")
            Control(if (state.cameraEnabled) Icons.Rounded.Videocam else Icons.Rounded.VideocamOff, state.cameraEnabled, false, onCamera, "Camera")
            Control(Icons.Rounded.PresentToAll, state.screenShareEnabled, false, onScreenShare, "Share screen")
            Control(Icons.Rounded.CallEnd, false, true, session::leave, "Leave")
        }
    }
    selectedMember?.let { member ->
        AlertDialog(
            onDismissRequest = { selectedMember = null },
            title = { Text(member.name) },
            text = {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                    if (!isImageAvatar(member.avatar)) {
                        Box(Modifier.size(110.dp).clip(CircleShape).background(MHTalkPurple), contentAlignment = Alignment.Center) {
                            Text(member.avatar.take(1).ifBlank { member.name.take(1) }.uppercase(), fontSize = 38.sp, fontWeight = FontWeight.Black)
                        }
                    } else {
                        AsyncImage(
                            model = member.avatar,
                            contentDescription = member.name,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.size(110.dp).clip(CircleShape),
                        )
                    }
                    Spacer(Modifier.height(14.dp))
                    Text(member.bio.ifBlank { "No bio yet." }, color = MHTalkMuted)
                    if (member.identity != "me") {
                        Spacer(Modifier.height(20.dp))
                        Text("User volume · ${member.userVolume}%", modifier = Modifier.fillMaxWidth(), fontWeight = FontWeight.Bold)
                        Slider(
                            value = member.userVolume.toFloat(),
                            onValueChange = { value ->
                                val volume = value.toInt()
                                session.setParticipantVolume(member.identity, stream = false, volume)
                                selectedMember = member.copy(userVolume = volume)
                            },
                            valueRange = 0f..100f,
                        )
                        if (member.screenShareEnabled) {
                            Text("Stream volume · ${member.streamVolume}%", modifier = Modifier.fillMaxWidth(), fontWeight = FontWeight.Bold)
                            Slider(
                                value = member.streamVolume.toFloat(),
                                onValueChange = { value ->
                                    val volume = value.toInt()
                                    session.setParticipantVolume(member.identity, stream = true, volume)
                                    selectedMember = member.copy(streamVolume = volume)
                                },
                                valueRange = 0f..100f,
                            )
                        }
                        HorizontalDivider(Modifier.padding(vertical = 12.dp))
                        TextButton(
                            onClick = { session.reportUser(member.identity); selectedMember = null },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("Report user") }
                        TextButton(
                            onClick = { session.blockUser(member.identity); selectedMember = null },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("Block user", color = Color(0xFFFF7A8D)) }
                    }
                }
            },
            confirmButton = { TextButton({ selectedMember = null }) { Text("Close") } },
        )
    }
}

@Composable
private fun VideoTile(track: VideoTrack, session: SessionViewModel, label: String) {
    Surface(
        modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f),
        color = Color.Black,
        shape = RoundedCornerShape(18.dp),
    ) {
        Box {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { context ->
                    SurfaceViewRenderer(context).also {
                        session.initializeVideoRenderer(it)
                        it.setMirror(label == "Your camera")
                        track.addRenderer(it)
                    }
                },
                onRelease = {
                    track.removeRenderer(it)
                    it.release()
                },
            )
            Text(
                label,
                modifier = Modifier.align(Alignment.BottomStart).background(Color(0x99000000)).padding(horizontal = 10.dp, vertical = 5.dp),
                color = Color.White,
                fontSize = 12.sp,
            )
        }
    }
}

@Composable
private fun MemberRow(member: MemberUi, mine: Boolean, onClick: (MemberUi) -> Unit) {
    Surface(
        onClick = { onClick(member) },
        color = Color.Transparent,
        shape = RoundedCornerShape(16.dp),
        border = if (member.speaking) androidx.compose.foundation.BorderStroke(1.5.dp, MHTalkGreen) else null,
    ) {
        Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (!isImageAvatar(member.avatar)) {
                Box(Modifier.size(43.dp).clip(CircleShape).background(if (mine) MHTalkPurple else Color(0xFF343A59)), contentAlignment = Alignment.Center) {
                    Text(member.avatar.take(1).ifBlank { member.name.take(1) }.uppercase(), fontWeight = FontWeight.Black)
                }
            } else {
                AsyncImage(model = member.avatar, contentDescription = member.name, contentScale = ContentScale.Crop, modifier = Modifier.size(43.dp).clip(CircleShape))
            }
            Column(Modifier.padding(start = 12.dp).weight(1f)) {
                Text(member.name, fontWeight = FontWeight.Bold)
                Text(if (member.microphoneEnabled) "Mic on" else "Listening", color = MHTalkMuted, fontSize = 12.sp)
            }
            if (member.cameraEnabled) Icon(Icons.Rounded.Videocam, "Camera on", tint = MHTalkGreen)
        }
    }
}

@Composable
private fun Control(icon: ImageVector, active: Boolean, danger: Boolean, onClick: () -> Unit, description: String) {
    IconButton(
        onClick, modifier = Modifier.size(54.dp).clip(CircleShape).background(
            when { danger -> Color(0xFF7A3045); active -> Color(0xFF245F4D); else -> Color(0xFF2B3049) },
        ),
    ) { Icon(icon, description) }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RoomChat(state: SessionUiState, session: SessionViewModel) {
    var text by remember { mutableStateOf("") }
    var imagePreview by remember { mutableStateOf<String?>(null) }
    var selectedMessage by remember { mutableStateOf<ChatMessageUi?>(null) }
    var replyTo by remember { mutableStateOf<ChatMessageUi?>(null) }
    var editing by remember { mutableStateOf<ChatMessageUi?>(null) }
    var emojiOpen by remember { mutableStateOf(false) }
    var newMessageLabel by remember { mutableStateOf<String?>(null) }
    val focusRequester = remember { FocusRequester() }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val attachmentPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) session.sendAttachment(uri)
    }
    val submitMessage = {
        if (text.isNotBlank()) {
            session.updateTyping(false)
            editing?.let { session.editMessage(it.id, text) } ?: session.sendMessage(text, replyTo)
            text = ""
            editing = null
            replyTo = null
        }
    }
    val listState = rememberLazyListState()
    LaunchedEffect(state.messages.size) {
        if (state.messages.isEmpty()) {
            newMessageLabel = null
        } else {
            val newLast = state.messages.lastIndex
            val visibleLast = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
            if (newLast == 0 || visibleLast >= newLast - 1) {
                listState.animateScrollToItem(newLast)
                newMessageLabel = null
            } else {
                newMessageLabel = if (state.messages.last().mine) "Your last message" else "New message"
            }
        }
    }
    Column(Modifier.fillMaxSize().then(if (imagePreview != null) Modifier.blur(8.dp) else Modifier)) {
        Box(Modifier.weight(1f)) {
            LazyColumn(
                state = listState, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
            if (state.messages.isEmpty()) item { Box(Modifier.fillParentMaxSize(), contentAlignment = Alignment.Center) { Text("Messages appear here.", color = MHTalkMuted) } }
            items(state.messages, key = { it.id }) { message ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = if (message.mine) Arrangement.End else Arrangement.Start) {
                    Surface(
                        color = if (message.mine) Color(0xFF5749A8) else Color(0xFF20253A),
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.fillMaxWidth(0.82f).combinedClickable(
                            onClick = {},
                            onLongClick = { if (!message.deleted) selectedMessage = message },
                        ),
                    ) {
                        Column(Modifier.padding(11.dp)) {
                            Text(message.sender, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                            if (!message.replyToId.isNullOrBlank()) {
                                Surface(
                                    color = Color(0x44202020),
                                    shape = RoundedCornerShape(8.dp),
                                    modifier = Modifier.fillMaxWidth().clickable {
                                        val index = state.messages.indexOfFirst { it.id == message.replyToId }
                                        if (index >= 0) scope.launch { listState.animateScrollToItem(index) }
                                    },
                                ) {
                                    Column(Modifier.padding(7.dp)) {
                                        Text(message.replyToSender.orEmpty(), color = MHTalkPurple, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                                        Text(message.replyToBody.orEmpty(), maxLines = 2, color = MHTalkMuted, fontSize = 11.sp)
                                    }
                                }
                                Spacer(Modifier.height(5.dp))
                            }
                            if (message.deleted) {
                                Text("Message deleted", color = MHTalkMuted)
                            } else {
                                message.attachment?.let { attachment ->
                                    if (attachment.mimeType.startsWith("image/")) {
                                        AsyncImage(
                                            model = attachment.uri,
                                            contentDescription = attachment.name,
                                            modifier = Modifier.fillMaxWidth().heightIn(max = 260.dp).clip(RoundedCornerShape(12.dp)).clickable { imagePreview = attachment.uri },
                                        )
                                    } else if (attachment.mimeType.startsWith("audio/")) {
                                        VoiceAttachment(attachment.uri, attachment.name)
                                    } else if (attachment.mimeType.startsWith("video/")) {
                                        VideoAttachment(attachment.uri, attachment.name)
                                    } else {
                                        Row(
                                            verticalAlignment = Alignment.CenterVertically,
                                            modifier = Modifier.fillMaxWidth().clickable {
                                                openAttachment(context, attachment.uri, attachment.mimeType)
                                            },
                                        ) {
                                            Icon(Icons.Rounded.InsertDriveFile, null, tint = MHTalkPurple)
                                            Column(Modifier.padding(start = 8.dp).weight(1f)) {
                                                Text(attachment.name, maxLines = 2)
                                                Text(formatBytes(attachment.size), color = MHTalkMuted, fontSize = 11.sp)
                                            }
                                        }
                                    }
                                    if (attachment.sending) {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            LinearProgressIndicator(
                                                progress = { attachment.progress },
                                                modifier = Modifier.weight(1f).padding(top = 7.dp),
                                            )
                                            IconButton({ session.cancelAttachment(message.id) }, Modifier.size(34.dp)) {
                                                Icon(Icons.Rounded.Close, "Cancel sending")
                                            }
                                        }
                                    }
                                }
                                if (message.body.isNotBlank()) Text(message.body, color = Color.White)
                            }
                        }
                    }
                }
            }
            }
            newMessageLabel?.let { label ->
                FilledTonalButton(
                    onClick = {
                        scope.launch {
                            listState.animateScrollToItem(state.messages.lastIndex)
                            newMessageLabel = null
                        }
                    },
                    modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp),
                ) {
                    Icon(Icons.Rounded.KeyboardArrowDown, null)
                    Spacer(Modifier.width(5.dp))
                    Text(label)
                }
            }
        }
        Column(Modifier.fillMaxWidth().background(Color(0xFF111522))) {
            if (state.typingNames.isNotEmpty()) {
                Text(
                    "${state.typingNames.joinToString()} ${if (state.typingNames.size == 1) "is" else "are"} typing…",
                    color = MHTalkMuted,
                    fontSize = 11.sp,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 5.dp),
                )
            }
            (editing ?: replyTo)?.let { target ->
                Row(Modifier.fillMaxWidth().background(Color(0xFF20253A)).padding(horizontal = 12.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(if (editing != null) "Editing message" else "Replying to ${target.sender}", color = MHTalkPurple, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                        Text(target.body, maxLines = 1, color = MHTalkMuted, fontSize = 11.sp)
                    }
                    IconButton(onClick = { editing = null; replyTo = null; text = "" }) { Icon(Icons.Rounded.Close, "Cancel") }
                }
            }
            Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(
                onClick = { attachmentPicker.launch(arrayOf("image/*", "video/*", "audio/*", "application/*", "text/*")) },
                modifier = Modifier.size(46.dp).clip(CircleShape).background(Color(0xFF2B3049)),
            ) { Icon(Icons.Rounded.Add, "Attach file") }
            Spacer(Modifier.width(7.dp))
            OutlinedTextField(
                text,
                {
                    text = it.take(8_000)
                    session.updateTyping(text.isNotBlank())
                },
                Modifier.weight(1f).focusRequester(focusRequester),
                placeholder = { Text("Write a message") },
                maxLines = 3,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { submitMessage() }),
                shape = RoundedCornerShape(18.dp),
                trailingIcon = {
                    Box {
                        IconButton({ emojiOpen = true }) { Icon(Icons.Rounded.EmojiEmotions, "Emojis") }
                        DropdownMenu(emojiOpen, { emojiOpen = false }) {
                            LazyVerticalGrid(
                                columns = GridCells.Fixed(6),
                                modifier = Modifier.width(300.dp).heightIn(max = 320.dp),
                                contentPadding = PaddingValues(8.dp),
                            ) {
                                items(emojis) { emoji ->
                                    TextButton(
                                        onClick = { text += emoji },
                                        contentPadding = PaddingValues(2.dp),
                                        modifier = Modifier.size(46.dp),
                                    ) { Text(emoji, fontSize = 24.sp) }
                                }
                            }
                        }
                    }
                },
            )
            Spacer(Modifier.width(8.dp))
            if (text.isBlank() && editing == null && replyTo == null) {
                IconButton(
                    onClick = session::toggleVoiceRecording,
                    modifier = Modifier.size(48.dp).clip(CircleShape).background(if (state.isRecordingVoice) Color(0xFFB33951) else MHTalkPurple),
                ) { Icon(if (state.isRecordingVoice) Icons.Rounded.Stop else Icons.Rounded.FiberManualRecord, if (state.isRecordingVoice) "Stop voice note" else "Record voice note") }
            } else {
                IconButton(
                    onClick = submitMessage,
                    enabled = text.isNotBlank(),
                    modifier = Modifier.size(48.dp).clip(CircleShape).background(MHTalkPurple),
                ) { Icon(Icons.Rounded.Send, "Send") }
            }
            }
        }
    }
    imagePreview?.let { uri ->
        androidx.compose.ui.window.Dialog(
            onDismissRequest = { imagePreview = null },
            properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Box(
                Modifier.fillMaxSize().background(Color(0x99000000)).clickable { imagePreview = null }.padding(18.dp),
                contentAlignment = Alignment.Center,
            ) {
                AsyncImage(
                    model = uri,
                    contentDescription = "Image preview",
                    modifier = Modifier.fillMaxWidth().fillMaxHeight(0.86f).clickable(enabled = false) {},
                )
            }
        }
    }
    selectedMessage?.let { message ->
        AlertDialog(
            onDismissRequest = { selectedMessage = null },
            title = { Text("Message") },
            text = {
                Column {
                    TextButton(
                        onClick = {
                            replyTo = message
                            selectedMessage = null
                            scope.launch { focusRequester.requestFocus() }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Reply") }
                    TextButton(
                        onClick = {
                            val clipboard = context.getSystemService(ClipboardManager::class.java)
                            clipboard.setPrimaryClip(ClipData.newPlainText("MHTalk message", message.body))
                            selectedMessage = null
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Copy") }
                    if (message.mine && message.attachment == null) {
                        TextButton(
                            onClick = {
                                editing = message
                                text = message.body
                                selectedMessage = null
                                scope.launch { focusRequester.requestFocus() }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("Edit") }
                    }
                    if (message.mine) {
                        TextButton(
                            onClick = { session.deleteMessage(message.id); selectedMessage = null },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("Delete", color = Color(0xFFFF7A8D)) }
                    } else if (!message.senderIdentity.isNullOrBlank()) {
                        TextButton(
                            onClick = { session.reportUser(message.senderIdentity, message); selectedMessage = null },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("Report message") }
                        TextButton(
                            onClick = { session.blockUser(message.senderIdentity); selectedMessage = null },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("Block user", color = Color(0xFFFF7A8D)) }
                    }
                }
            },
            confirmButton = { TextButton({ selectedMessage = null }) { Text("Close") } },
        )
    }
}

@Composable
private fun VideoAttachment(uri: String, name: String) {
    AndroidView(
        factory = { context ->
            VideoView(context).apply {
                val controls = MediaController(context)
                controls.setAnchorView(this)
                setMediaController(controls)
                setVideoURI(Uri.parse(uri))
                setOnPreparedListener { player ->
                    player.isLooping = false
                    seekTo(1)
                }
            }
        },
        update = { view ->
            if (view.tag != uri) {
                view.tag = uri
                view.setVideoURI(Uri.parse(uri))
            }
        },
        onRelease = { it.stopPlayback() },
        modifier = Modifier.fillMaxWidth().height(210.dp).clip(RoundedCornerShape(12.dp)),
    )
    Text(name, maxLines = 1, color = MHTalkMuted, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
}

private fun openAttachment(context: Context, uri: String, mimeType: String) {
    runCatching {
        context.startActivity(
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(Uri.parse(uri), mimeType)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            },
        )
    }
}

@Composable
private fun VoiceAttachment(uri: String, name: String) {
    val context = LocalContext.current
    var player by remember(uri) { mutableStateOf<MediaPlayer?>(null) }
    var ready by remember(uri) { mutableStateOf(false) }
    var playing by remember(uri) { mutableStateOf(false) }
    var duration by remember(uri) { mutableIntStateOf(0) }
    var position by remember(uri) { mutableIntStateOf(0) }

    DisposableEffect(uri) {
        val mediaPlayer = MediaPlayer()
        player = mediaPlayer
        runCatching {
            mediaPlayer.setDataSource(context, Uri.parse(uri))
            mediaPlayer.setOnPreparedListener {
                duration = it.duration.coerceAtLeast(0)
                ready = true
            }
            mediaPlayer.setOnCompletionListener {
                playing = false
                position = 0
                it.seekTo(0)
            }
            mediaPlayer.prepareAsync()
        }.onFailure {
            ready = false
        }
        onDispose {
            runCatching { mediaPlayer.release() }
            player = null
        }
    }
    LaunchedEffect(playing, player) {
        while (playing) {
            position = runCatching { player?.currentPosition ?: 0 }.getOrDefault(0)
            delay(150)
        }
    }

    Column(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(
                onClick = {
                    player?.let {
                        if (playing) it.pause() else it.start()
                        playing = !playing
                    }
                },
                enabled = ready,
                modifier = Modifier.size(42.dp).clip(CircleShape).background(Color.White),
            ) {
                Icon(if (playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, name, tint = Color(0xFF272342))
            }
            Slider(
                value = position.toFloat(),
                onValueChange = {
                    position = it.toInt()
                    player?.seekTo(position)
                },
                valueRange = 0f..duration.coerceAtLeast(1).toFloat(),
                enabled = ready,
                modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
            )
            Text("${formatDuration(position)} / ${formatDuration(duration)}", fontSize = 11.sp, color = MHTalkMuted)
        }
        Row(
            Modifier.fillMaxWidth().height(22.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            listOf(9, 14, 20, 11, 17, 23, 13, 19, 10, 16, 22, 12, 18, 8, 15, 21, 11, 17).forEach { height ->
                Box(Modifier.width(3.dp).height(height.dp).clip(CircleShape).background(Color(0xFFC7BFFF)))
            }
        }
    }
}

private fun formatDuration(milliseconds: Int): String {
    val seconds = (milliseconds.coerceAtLeast(0) / 1_000)
    return "%d:%02d".format(seconds / 60, seconds % 60)
}

private val emojis = listOf(
    "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😍", "🥰", "😘",
    "😎", "🤩", "🥳", "🙂", "🙃", "😉", "😌", "😋", "😜", "🤔", "🫡", "🤗",
    "😭", "😢", "😡", "🤬", "😱", "😴", "🥺", "😏", "🙄", "😬", "🤯", "🫠",
    "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "💕", "💯", "🔥",
    "👍", "👎", "👏", "🙌", "🙏", "🤝", "💪", "👌", "✌️", "🤞", "👀", "🫶",
    "✅", "❌", "⚠️", "🎉", "🎮", "🎧", "🎤", "📷", "💻", "📱", "🚀", "✨",
)

private fun formatBytes(size: Long): String = when {
    size < 0 -> "File"
    size < 1024 -> "$size B"
    size < 1024 * 1024 -> "${size / 1024} KB"
    else -> "${size / (1024 * 1024)} MB"
}

@Composable
private fun ProfileDialog(
    profile: UserProfile,
    onDismiss: () -> Unit,
    onSave: (UserProfile) -> Unit,
    onChoosePhoto: () -> Unit,
    onRemovePhoto: () -> Unit,
) {
    var name by remember(profile.name) { mutableStateOf(profile.name) }
    var bio by remember(profile.bio) { mutableStateOf(profile.bio) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit profile") },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                if (!isImageAvatar(profile.avatar)) {
                    Box(Modifier.size(92.dp).clip(CircleShape).background(MHTalkPurple), contentAlignment = Alignment.Center) {
                        Text(profile.avatar.take(1).ifBlank { name.take(1) }.uppercase(), fontSize = 28.sp, fontWeight = FontWeight.Black)
                    }
                } else {
                    AsyncImage(model = profile.avatar, contentDescription = "Profile photo", contentScale = ContentScale.Crop, modifier = Modifier.size(92.dp).clip(CircleShape))
                }
                Row {
                    TextButton(onChoosePhoto) { Text("Choose photo") }
                    if (profile.avatar.isNotBlank()) TextButton(onRemovePhoto) { Text("Remove") }
                }
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(32) },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Name") },
                    singleLine = true,
                )
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = bio,
                    onValueChange = { bio = it.take(160) },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Bio") },
                    minLines = 2,
                    maxLines = 4,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(profile.copy(name = name.trim().ifBlank { "Me" }, bio = bio.trim())) }) {
                Text("Save")
            }
        },
        dismissButton = { TextButton(onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun ProfileCropDialog(
    uri: Uri,
    onDismiss: () -> Unit,
    onUse: (Float, Float, Float) -> Unit,
) {
    val context = LocalContext.current
    val density = LocalDensity.current
    val mimeType = remember(uri) { context.contentResolver.getType(uri).orEmpty() }
    val animated = mimeType.equals("image/gif", ignoreCase = true)
    val dimensions = remember(uri) {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
        options.outWidth.coerceAtLeast(1) to options.outHeight.coerceAtLeast(1)
    }
    var zoom by remember(uri) { mutableFloatStateOf(1f) }
    var offsetX by remember(uri) { mutableFloatStateOf(0f) }
    var offsetY by remember(uri) { mutableFloatStateOf(0f) }
    val previewSize = 230.dp
    val previewPx = with(density) { previewSize.toPx() }
    val baseScale = maxOf(previewPx / dimensions.first, previewPx / dimensions.second)
    val translationX = offsetX * ((dimensions.first * baseScale * zoom - previewPx).coerceAtLeast(0f) / 2f)
    val translationY = offsetY * ((dimensions.second * baseScale * zoom - previewPx).coerceAtLeast(0f) / 2f)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Crop profile photo") },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    Modifier.size(previewSize).clip(CircleShape).background(Color(0xFF101422)),
                    contentAlignment = Alignment.Center,
                ) {
                    AsyncImage(
                        model = uri,
                        contentDescription = "Exact avatar preview",
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize().graphicsLayer {
                            scaleX = zoom
                            scaleY = zoom
                            this.translationX = translationX
                            this.translationY = translationY
                        },
                    )
                }
                Spacer(Modifier.height(16.dp))
                if (animated) {
                    Text("Animated image · the centered circular crop is preserved.", color = MHTalkMuted, fontSize = 12.sp)
                } else {
                    Text("Zoom · ${(zoom * 100).toInt()}%", modifier = Modifier.fillMaxWidth(), color = MHTalkMuted)
                    Slider(zoom, { zoom = it }, valueRange = 1f..3f)
                    Text("Move left / right", modifier = Modifier.fillMaxWidth(), color = MHTalkMuted)
                    Slider(offsetX, { offsetX = it }, valueRange = -1f..1f)
                    Text("Move up / down", modifier = Modifier.fillMaxWidth(), color = MHTalkMuted)
                    Slider(offsetY, { offsetY = it }, valueRange = -1f..1f)
                }
            }
        },
        confirmButton = { TextButton({ onUse(zoom, offsetX, offsetY) }) { Text("Use this photo") } },
        dismissButton = { TextButton(onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun SettingsDialog(
    state: SessionUiState,
    onDismiss: () -> Unit,
    onOutput: (Int) -> Unit,
    onTestSpeaker: () -> Unit,
    onSwitchCamera: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Settings") },
        text = {
            Column {
                Text("Speaker", fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))
                Text("Output level · ${state.outputLevel}%", color = MHTalkMuted)
                Slider(
                    value = state.outputLevel.toFloat(),
                    onValueChange = { onOutput(it.toInt()) },
                    valueRange = 0f..100f,
                )
                OutlinedButton(onTestSpeaker, Modifier.fillMaxWidth()) { Text("Test speaker") }
                Spacer(Modifier.height(18.dp))
                Text("Camera", fontWeight = FontWeight.Bold)
                Text("Android uses the selected system camera.", color = MHTalkMuted, fontSize = 12.sp)
                OutlinedButton(
                    onClick = onSwitchCamera,
                    enabled = state.cameraEnabled,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Switch front / back") }
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("Done") } },
    )
}

@Composable
private fun HelpDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Help center") },
        text = {
            LazyColumn(Modifier.heightIn(max = 470.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item {
                    Text("Using MHTalk", fontWeight = FontWeight.Bold)
                    Text("MHTalk provides voice, camera, screen sharing, chat and private invite rooms. Only share content you own or are allowed to distribute.", color = MHTalkMuted)
                }
                item {
                    Text("Community safety", fontWeight = FontWeight.Bold)
                    Text("Do not use MHTalk for harassment, threats, sexual exploitation, illegal content, malware, privacy violations or copyright infringement. Public Main messages are moderated; private rooms remain the responsibility of their participants. Long-press a message or open a member profile to report or block.", color = MHTalkMuted)
                }
                item {
                    Text("Privacy", fontWeight = FontWeight.Bold)
                    Text("Voice and video travel through LiveKit for realtime delivery. Files are transferred to connected room participants. MHTalk does not require your LiveKit secret on the phone.", color = MHTalkMuted)
                    TextButton(
                        onClick = {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/mhlko-tech/MhlkoTalk/blob/main/MHTalk%20Android/PRIVACY_POLICY.md")))
                        },
                    ) { Text("Open full Privacy Policy") }
                }
                item {
                    Text("Permissions", fontWeight = FontWeight.Bold)
                    Text("Microphone, camera, notifications and screen-capture permissions are requested only when their related feature is used. Screen capture always uses Android's system confirmation.", color = MHTalkMuted)
                }
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("Close") } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PrivateRoomSheet(onDismiss: () -> Unit, onCreate: () -> Unit, onJoin: (String) -> Unit) {
    var code by remember { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Color(0xFF191E31)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 30.dp)) {
            Text("Private channel", fontWeight = FontWeight.ExtraBold, fontSize = 24.sp)
            Text("Create a room or enter your friend's invite code.", color = MHTalkMuted)
            Spacer(Modifier.height(20.dp))
            Button(onCreate, Modifier.fillMaxWidth().height(52.dp)) { Text("Create private room", fontWeight = FontWeight.Bold) }
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(code, { code = it.uppercase().take(12) }, Modifier.fillMaxWidth(), label = { Text("MHTALK-0000E") }, singleLine = true)
            Spacer(Modifier.height(10.dp))
            OutlinedButton({ onJoin(code) }, Modifier.fillMaxWidth().height(52.dp), enabled = code.isNotBlank()) { Text("Join private room", fontWeight = FontWeight.Bold) }
        }
    }
}

private fun isImageAvatar(value: String): Boolean {
    val normalized = value.lowercase()
    return normalized.startsWith("data:image/") ||
        normalized.startsWith("content://") ||
        normalized.startsWith("file://") ||
        normalized.startsWith("http://") ||
        normalized.startsWith("https://")
}

private fun statusText(status: ConnectionStatus) = when (status) {
    ConnectionStatus.Idle -> "Ready"
    ConnectionStatus.Connecting -> "Connecting"
    ConnectionStatus.Connected -> "Connected"
    ConnectionStatus.Recovering -> "Reconnecting"
    ConnectionStatus.Failed -> "Connection unavailable"
}

private fun statusColor(status: ConnectionStatus) = when (status) {
    ConnectionStatus.Connected -> MHTalkGreen
    ConnectionStatus.Connecting, ConnectionStatus.Recovering -> Color(0xFFFFC857)
    ConnectionStatus.Failed -> Color(0xFFFF7A8D)
    else -> MHTalkMuted
}
