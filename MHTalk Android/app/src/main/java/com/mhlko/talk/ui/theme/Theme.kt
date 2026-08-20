package com.mhlko.talk.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val MHTalkPurple = Color(0xFF7664F2)
val MHTalkGreen = Color(0xFF59E6A7)
val MHTalkBackground = Color(0xFF0D101C)
val MHTalkSurface = Color(0xFF151929)
val MHTalkSurfaceRaised = Color(0xFF20253A)
val MHTalkText = Color(0xFFF4F5FF)
val MHTalkMuted = Color(0xFF9BA6CF)

private val MHTalkColors = darkColorScheme(
    primary = MHTalkPurple,
    secondary = MHTalkGreen,
    background = MHTalkBackground,
    surface = MHTalkSurface,
    surfaceVariant = MHTalkSurfaceRaised,
    onPrimary = Color.White,
    onBackground = MHTalkText,
    onSurface = MHTalkText,
    onSurfaceVariant = MHTalkMuted,
)

@Composable
fun MHTalkTheme(content: @Composable () -> Unit) {
    isSystemInDarkTheme()
    MaterialTheme(colorScheme = MHTalkColors, content = content)
}
