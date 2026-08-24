package com.mhlko.talk.auth

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Reserved integration point for the future MHTalk account service.
 * Rooms deliberately continue to work anonymously until the service is available.
 */
data class MHTalkAccount(
    val id: String,
    val displayName: String,
    val accessToken: String,
)

sealed interface AuthState {
    data object Anonymous : AuthState
    data class SignedIn(val account: MHTalkAccount) : AuthState
}

class AuthRepository(context: Context) {
    private val preferences = context.getSharedPreferences("mhtalk.auth", Context.MODE_PRIVATE)
    private val _state = MutableStateFlow<AuthState>(restore())
    val state: StateFlow<AuthState> = _state.asStateFlow()

    private fun restore(): AuthState {
        val id = preferences.getString("account.id", null) ?: return AuthState.Anonymous
        val name = preferences.getString("account.name", null) ?: return AuthState.Anonymous
        val token = preferences.getString("account.token", null) ?: return AuthState.Anonymous
        return AuthState.SignedIn(MHTalkAccount(id, name, token))
    }

    /** Called later by the MHTalk website OAuth/API hand-off. */
    fun completeFutureSignIn(account: MHTalkAccount) {
        preferences.edit()
            .putString("account.id", account.id)
            .putString("account.name", account.displayName)
            .putString("account.token", account.accessToken)
            .apply()
        _state.value = AuthState.SignedIn(account)
    }

    fun signOut() {
        preferences.edit().clear().apply()
        _state.value = AuthState.Anonymous
    }
}
