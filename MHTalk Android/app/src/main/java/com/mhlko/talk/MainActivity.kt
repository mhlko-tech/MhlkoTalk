package com.mhlko.talk

import android.os.Bundle
import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.mhlko.talk.ui.MHTalkApp
import com.mhlko.talk.ui.PipController
import com.mhlko.talk.ui.theme.MHTalkTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MHTalkTheme {
                MHTalkApp()
            }
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        PipController.inPictureInPicture = isInPictureInPictureMode
        if (!isInPictureInPictureMode) PipController.track = null
    }
}
