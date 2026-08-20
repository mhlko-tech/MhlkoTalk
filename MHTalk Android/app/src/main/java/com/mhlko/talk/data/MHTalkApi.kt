package com.mhlko.talk.data

import com.mhlko.talk.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class RoomCredentials(val token: String, val roomName: String)
data class PrivateRoom(val roomName: String, val code: String)

class MHTalkApi {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val origin = BuildConfig.TOKEN_ENDPOINT.substringBefore("/livekit/token")

    suspend fun credentials(roomName: String, inviteCode: String?): RoomCredentials = post(
        BuildConfig.TOKEN_ENDPOINT,
        JSONObject().put("roomName", roomName).apply {
            if (!inviteCode.isNullOrBlank()) put("inviteCode", inviteCode.trim().uppercase())
        },
    ).let { payload ->
        RoomCredentials(
            token = payload.requireString("token"),
            roomName = payload.requireString("roomName"),
        )
    }

    suspend fun createPrivateRoom(): PrivateRoom = post(
        "$origin/private-room",
        JSONObject(),
    ).let { payload ->
        PrivateRoom(
            roomName = payload.requireString("roomName"),
            code = payload.requireString("code"),
        )
    }

    suspend fun mainCount(): Int = post(
        "$origin/room-count",
        JSONObject().put("roomName", "Main"),
    ).optInt("count", 0)

    suspend fun moderate(text: String): String = post(
        "$origin/moderate",
        JSONObject().put("roomName", "Main").put("text", text),
    ).optString("text", text)

    suspend fun report(roomName: String, reporterIdentity: String, targetIdentity: String, messageId: String?, content: String?) {
        post(
            "$origin/moderation/report",
            JSONObject()
                .put("roomName", roomName)
                .put("reporterIdentity", reporterIdentity)
                .put("targetIdentity", targetIdentity)
                .put("messageId", messageId ?: JSONObject.NULL)
                .put("content", content?.take(2_000) ?: JSONObject.NULL),
        )
    }

    private suspend fun post(url: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(url)
            .post(body.toString().toRequestBody(jsonType))
            .build()
        client.newCall(request).execute().use { response ->
            val text = response.body.string()
            if (!response.isSuccessful) {
                val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
                throw IllegalStateException(message?.takeIf { it.isNotBlank() } ?: "Connection service unavailable")
            }
            JSONObject(text)
        }
    }

    private fun JSONObject.requireString(key: String): String =
        optString(key).takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("Invalid server response")
}
