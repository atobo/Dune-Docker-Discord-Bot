package com.example.duneservermanager.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

class DuneServerClient(private val context: Context) {

  private val sharedPreferences = context.getSharedPreferences("DuneSettings", Context.MODE_PRIVATE)

  var serverIp: String
    get() = sharedPreferences.getString("server_ip", "192.168.1.33") ?: "192.168.1.33"
    set(value) = sharedPreferences.edit().putString("server_ip", value).apply()

  var serverPort: String
    get() = sharedPreferences.getString("server_port", "3005") ?: "3005"
    set(value) = sharedPreferences.edit().putString("server_port", value).apply()

  var apiToken: String
    get() = sharedPreferences.getString("api_token", "TFF-Dune-Admin-Token-777") ?: "TFF-Dune-Admin-Token-777"
    set(value) = sharedPreferences.edit().putString("api_token", value).apply()

  private val baseUrl: String
    get() = "http://$serverIp:$serverPort"

  private suspend fun makeRequest(path: String, method: String, body: String? = null): String = withContext(Dispatchers.IO) {
    val url = URL("$baseUrl$path")
    val conn = url.openConnection() as HttpURLConnection
    conn.requestMethod = method
    conn.connectTimeout = 15000
    conn.readTimeout = 60000 // For long updates
    conn.setRequestProperty("Content-Type", "application/json")
    conn.setRequestProperty("X-API-Token", apiToken)

    if (body != null) {
      conn.doOutput = true
      val writer = OutputStreamWriter(conn.outputStream)
      writer.write(body)
      writer.flush()
      writer.close()
    }

    val responseCode = conn.responseCode
    val stream = if (responseCode in 200..299) conn.inputStream else conn.errorStream
    val reader = BufferedReader(InputStreamReader(stream))
    val response = StringBuilder()
    var line: String?
    while (reader.readLine().also { line = it } != null) {
      response.append(line)
    }
    reader.close()

    if (responseCode !in 200..299) {
      val errMsg = try {
        JSONObject(response.toString()).getString("error")
      } catch (e: Exception) {
        "HTTP $responseCode: ${response.toString()}"
      }
      throw Exception(errMsg)
    }

    response.toString()
  }

  suspend fun getStatus(): String {
    return makeRequest("/api/status", "GET")
  }

  suspend fun getPlayers(): String {
    return makeRequest("/api/players", "GET")
  }

  suspend fun restartService(service: String): String {
    val body = JSONObject().put("service", service).toString()
    return makeRequest("/api/restart", "POST", body)
  }

  suspend fun runUpdate(action: String): String {
    val body = JSONObject().put("action", action).toString()
    return makeRequest("/api/update", "POST", body)
  }
}
