package com.mhlko.talk

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.mhlko.talk.ui.MHTalkApp
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
}
