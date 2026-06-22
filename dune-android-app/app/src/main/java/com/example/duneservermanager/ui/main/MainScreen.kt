package com.example.duneservermanager.ui.main

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.duneservermanager.data.DuneServerClient
import com.example.duneservermanager.theme.*
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(
  onItemClick: (androidx.navigation3.runtime.NavKey) -> Unit,
  modifier: Modifier = Modifier
) {
  val context = LocalContext.current
  val coroutineScope = rememberCoroutineScope()
  val client = remember { DuneServerClient(context) }

  var serverIp by remember { mutableStateOf(client.serverIp) }
  var serverPort by remember { mutableStateOf(client.serverPort) }
  var apiToken by remember { mutableStateOf(client.apiToken) }

  var showSettings by remember { mutableStateOf(false) }
  var isRefreshing by remember { mutableStateOf(false) }

  // Server state variables
  var overallStatus by remember { mutableStateOf("UNKNOWN") }
  var serverTitle by remember { mutableStateOf("Dune Server Manager") }
  var population by remember { mutableStateOf("0/0") }
  var dbConnected by remember { mutableStateOf(false) }
  var postgresStatus by remember { mutableStateOf("Offline") }
  var gatewayStatus by remember { mutableStateOf("Offline") }
  var directorStatus by remember { mutableStateOf("Offline") }
  var gameServers by remember { mutableStateOf<List<Pair<String, Pair<String, String>>>>(emptyList()) }
  var errorMessage by remember { mutableStateOf<String?>(null) }

  // Action variables
  var logOutput by remember { mutableStateOf("") }
  var selectedService by remember { mutableStateOf("survival") }
  var showServiceDropdown by remember { mutableStateOf(false) }
  var isActionRunning by remember { mutableStateOf(false) }

  val services = listOf(
    "postgres" to "Postgres Database",
    "rmq-admin" to "RabbitMQ Admin",
    "rmq-game" to "RabbitMQ Game",
    "text-router" to "Text Router",
    "director" to "Director",
    "gateway" to "Gateway",
    "survival" to "Survival Server",
    "overmap" to "Overmap Server"
  )

  fun refreshData() {
    coroutineScope.launch {
      isRefreshing = true
      errorMessage = null
      try {
        val statusJsonStr = client.getStatus()
        val jsonObj = JSONObject(statusJsonStr)
        dbConnected = jsonObj.getBoolean("dbConnected")
        
        val statusObj = jsonObj.optJSONObject("status")
        if (statusObj != null) {
          val infoObj = statusObj.optJSONObject("info")
          if (infoObj != null) {
            overallStatus = infoObj.optString("overall", "UNKNOWN")
            serverTitle = infoObj.optString("title", "TFF Dune Server")
            population = infoObj.optString("population", "0/60")
            postgresStatus = infoObj.optString("postgres", "Offline")
            gatewayStatus = infoObj.optString("gateway", "Offline")
            directorStatus = infoObj.optString("director", "Offline")
          }
          
          val serversArr = statusObj.optJSONArray("servers")
          val serversList = mutableListOf<Pair<String, Pair<String, String>>>()
          if (serversArr != null) {
            for (i in 0 until serversArr.length()) {
              val srv = serversArr.getJSONObject(i)
              serversList.add(
                srv.getString("map") to (srv.getString("state") to srv.getString("uptime"))
              )
            }
          }
          gameServers = serversList
        } else {
          overallStatus = "ONLINE"
          serverTitle = "TFF Dune Server"
          population = "—"
          postgresStatus = if (dbConnected) "Up" else "Offline"
          gatewayStatus = "Up"
          directorStatus = "Up"
          gameServers = emptyList()
        }
      } catch (e: Exception) {
        errorMessage = e.message ?: "Failed to connect to Dune bot API"
        overallStatus = "OFFLINE"
      } finally {
        isRefreshing = false
      }
    }
  }

  fun restartService(service: String) {
    coroutineScope.launch {
      isActionRunning = true
      logOutput = "Requesting restart for $service..."
      try {
        val resStr = client.restartService(service)
        val jsonObj = JSONObject(resStr)
        val success = jsonObj.getBoolean("success")
        val output = jsonObj.optString("output", "")
        val error = jsonObj.optString("error", "")
        
        if (success) {
          logOutput = "✅ Restart completed successfully!\n\n$output"
        } else {
          logOutput = "❌ Restart failed:\n\n${error.ifEmpty { output }}"
        }
        refreshData()
      } catch (e: Exception) {
        logOutput = "❌ Error triggering restart: ${e.message}"
      } finally {
        isActionRunning = false
      }
    }
  }

  fun triggerUpdate(action: String) {
    coroutineScope.launch {
      isActionRunning = true
      logOutput = "Running update check/install ($action)..."
      try {
        val resStr = client.runUpdate(action)
        val jsonObj = JSONObject(resStr)
        val success = jsonObj.getBoolean("success")
        val output = jsonObj.optString("output", "")
        val error = jsonObj.optString("error", "")
        
        if (success) {
          logOutput = "✅ Update task completed successfully!\n\n$output"
        } else {
          logOutput = "❌ Update task failed:\n\n${error.ifEmpty { output }}"
        }
        refreshData()
      } catch (e: Exception) {
        logOutput = "❌ Error running update: ${e.message}"
      } finally {
        isActionRunning = false
      }
    }
  }

  // Trigger refresh on launch
  LaunchedEffect(key1 = serverIp, key2 = serverPort) {
    refreshData()
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = {
          Text(
            text = if (showSettings) "API Settings" else serverTitle,
            color = TextLight,
            fontWeight = FontWeight.Bold,
            fontSize = 20.sp
          )
        },
        colors = TopAppBarDefaults.topAppBarColors(
          containerColor = DuneDarkBackground
        ),
        navigationIcon = {
          if (showSettings) {
            IconButton(onClick = { showSettings = false }) {
              Icon(imageVector = Icons.Default.ArrowBack, contentDescription = "Back", tint = TextLight)
            }
          }
        },
        actions = {
          if (!showSettings) {
            IconButton(onClick = { refreshData() }, enabled = !isRefreshing) {
              Icon(imageVector = Icons.Default.Refresh, contentDescription = "Refresh", tint = DuneOrange)
            }
            IconButton(onClick = { showSettings = true }) {
              Icon(imageVector = Icons.Default.Settings, contentDescription = "Settings", tint = TextMuted)
            }
          }
        }
      )
    },
    containerColor = DuneDarkBackground
  ) { paddingValues ->
    Column(
      modifier = Modifier
        .fillMaxSize()
        .padding(paddingValues)
        .padding(16.dp)
        .verticalScroll(rememberScrollState()),
      verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
      if (showSettings) {
        // --- SETTINGS SCREEN ---
        Text(
          text = "Configure API connection to your Dune bot service.",
          color = TextMuted,
          fontSize = 14.sp
        )

        OutlinedTextField(
          value = serverIp,
          onValueChange = { serverIp = it },
          label = { Text("Server IP Address") },
          modifier = Modifier.fillMaxWidth(),
          colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = DuneOrange,
            unfocusedBorderColor = TextMuted,
            focusedTextColor = TextLight,
            unfocusedTextColor = TextLight
          )
        )

        OutlinedTextField(
          value = serverPort,
          onValueChange = { serverPort = it },
          label = { Text("Server Port") },
          modifier = Modifier.fillMaxWidth(),
          colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = DuneOrange,
            unfocusedBorderColor = TextMuted,
            focusedTextColor = TextLight,
            unfocusedTextColor = TextLight
          )
        )

        OutlinedTextField(
          value = apiToken,
          onValueChange = { apiToken = it },
          label = { Text("API Auth Token (X-API-Token)") },
          modifier = Modifier.fillMaxWidth(),
          colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = DuneOrange,
            unfocusedBorderColor = TextMuted,
            focusedTextColor = TextLight,
            unfocusedTextColor = TextLight
          )
        )

        Spacer(modifier = Modifier.height(16.dp))

        Button(
          onClick = {
            client.serverIp = serverIp
            client.serverPort = serverPort
            client.apiToken = apiToken
            showSettings = false
            refreshData()
          },
          modifier = Modifier.fillMaxWidth(),
          colors = ButtonDefaults.buttonColors(containerColor = DuneOrange)
        ) {
          Text("Save & Connect", color = TextLight, fontWeight = FontWeight.Bold)
        }
      } else {
        // --- DASHBOARD SCREEN ---
        if (errorMessage != null) {
          Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = DuneDarkCard),
            shape = RoundedCornerShape(12.dp)
          ) {
            Column(modifier = Modifier.padding(16.dp)) {
              Text(text = "Connection Error", color = StatusRed, fontWeight = FontWeight.Bold, fontSize = 16.sp)
              Spacer(modifier = Modifier.height(4.dp))
              Text(text = errorMessage!!, color = TextLight, fontSize = 14.sp)
              Spacer(modifier = Modifier.height(8.dp))
              Button(
                onClick = { refreshData() },
                colors = ButtonDefaults.buttonColors(containerColor = DuneOrange),
                modifier = Modifier.align(Alignment.End)
              ) {
                Text("Retry")
              }
            }
          }
        }

        // Summary Row
        Row(
          modifier = Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
          // Server State
          Card(
            modifier = Modifier.weight(1f),
            colors = CardDefaults.cardColors(containerColor = DuneDarkCard),
            shape = RoundedCornerShape(12.dp)
          ) {
            Column(
              modifier = Modifier.padding(16.dp),
              horizontalAlignment = Alignment.CenterHorizontally
            ) {
              Text("Server State", color = TextMuted, fontSize = 12.sp)
              Spacer(modifier = Modifier.height(8.dp))
              Row(verticalAlignment = Alignment.CenterVertically) {
                val color = if (overallStatus == "READY") StatusGreen else if (overallStatus == "UNKNOWN") StatusYellow else StatusRed
                Box(
                  modifier = Modifier
                    .size(10.dp)
                    .clip(RoundedCornerShape(5.dp))
                    .background(color)
                )
                Spacer(modifier = Modifier.width(6.dp))
                Text(
                  text = overallStatus,
                  color = TextLight,
                  fontWeight = FontWeight.Bold,
                  fontSize = 16.sp
                )
              }
            }
          }

          // Population
          Card(
            modifier = Modifier.weight(1f),
            colors = CardDefaults.cardColors(containerColor = DuneDarkCard),
            shape = RoundedCornerShape(12.dp)
          ) {
            Column(
              modifier = Modifier.padding(16.dp),
              horizontalAlignment = Alignment.CenterHorizontally
            ) {
              Text("Population", color = TextMuted, fontSize = 12.sp)
              Spacer(modifier = Modifier.height(8.dp))
              Text(
                text = population,
                color = TextLight,
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp
              )
            }
          }
        }

        // Infrastructure Components Health
        Card(
          modifier = Modifier.fillMaxWidth(),
          colors = CardDefaults.cardColors(containerColor = DuneDarkCard),
          shape = RoundedCornerShape(12.dp)
        ) {
          Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
          ) {
            Text(
              text = "Infrastructure Status",
              color = DuneOrange,
              fontWeight = FontWeight.Bold,
              fontSize = 14.sp
            )

            // DB Connection
            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically
            ) {
              Text("Database Connection", color = TextLight, fontSize = 14.sp)
              Text(
                text = if (dbConnected) "Connected" else "Disconnected",
                color = if (dbConnected) StatusGreen else StatusRed,
                fontWeight = FontWeight.Bold
              )
            }

            HorizontalDivider(color = DuneDarkBackground, thickness = 1.dp)

            // Postgres DB status
            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically
            ) {
              Text("Postgres Container", color = TextLight, fontSize = 14.sp)
              Text(
                text = postgresStatus,
                color = if (postgresStatus.startsWith("Up")) StatusGreen else StatusRed,
                fontWeight = FontWeight.Bold
              )
            }

            HorizontalDivider(color = DuneDarkBackground, thickness = 1.dp)

            // Gateway Status
            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically
            ) {
              Text("Gateway Container", color = TextLight, fontSize = 14.sp)
              Text(
                text = gatewayStatus,
                color = if (gatewayStatus.startsWith("Up")) StatusGreen else StatusRed,
                fontWeight = FontWeight.Bold
              )
            }

            HorizontalDivider(color = DuneDarkBackground, thickness = 1.dp)

            // Director Status
            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically
            ) {
              Text("Director Container", color = TextLight, fontSize = 14.sp)
              Text(
                text = directorStatus,
                color = if (directorStatus.startsWith("Up")) StatusGreen else StatusRed,
                fontWeight = FontWeight.Bold
              )
            }
          }
        }

        // Game Server Map List
        Card(
          modifier = Modifier.fillMaxWidth(),
          colors = CardDefaults.cardColors(containerColor = DuneDarkCard),
          shape = RoundedCornerShape(12.dp)
        ) {
          Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
          ) {
            Text(
              text = "Game Server Partitions",
              color = DuneOrange,
              fontWeight = FontWeight.Bold,
              fontSize = 14.sp
            )

            if (gameServers.isEmpty()) {
              Text("No active game servers found.", color = TextMuted, fontSize = 14.sp)
            } else {
              gameServers.forEachIndexed { index, item ->
                val (map, stateUptime) = item
                val (state, uptime) = stateUptime
                Row(
                  modifier = Modifier.fillMaxWidth(),
                  horizontalArrangement = Arrangement.SpaceBetween,
                  verticalAlignment = Alignment.CenterVertically
                ) {
                  Column {
                    Text(text = map.replace("_", " "), color = TextLight, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                    Text(text = uptime, color = TextMuted, fontSize = 12.sp)
                  }
                  Text(
                    text = state,
                    color = if (state.lowercase() == "ready") StatusGreen else StatusYellow,
                    fontWeight = FontWeight.Bold
                  )
                }
                if (index < gameServers.size - 1) {
                  HorizontalDivider(color = DuneDarkBackground, thickness = 1.dp)
                }
              }
            }
          }
        }

        // Administrative Commands / Restarts
        Card(
          modifier = Modifier.fillMaxWidth(),
          colors = CardDefaults.cardColors(containerColor = DuneDarkCard),
          shape = RoundedCornerShape(12.dp)
        ) {
          Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
          ) {
            Text(
              text = "Server Controls",
              color = DuneOrange,
              fontWeight = FontWeight.Bold,
              fontSize = 14.sp
            )

            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.spacedBy(8.dp),
              verticalAlignment = Alignment.CenterVertically
            ) {
              // Service Selector Dropdown
              Box(
                modifier = Modifier
                  .weight(1f)
                  .border(1.dp, TextMuted, RoundedCornerShape(8.dp))
                  .clip(RoundedCornerShape(8.dp))
                  .clickable { showServiceDropdown = true }
                  .padding(horizontal = 12.dp, vertical = 14.dp)
              ) {
                val currentServiceLabel = services.firstOrNull { it.first == selectedService }?.second ?: selectedService
                Text(text = currentServiceLabel, color = TextLight, fontSize = 14.sp)
                
                DropdownMenu(
                  expanded = showServiceDropdown,
                  onDismissRequest = { showServiceDropdown = false },
                  modifier = Modifier.background(DuneDarkCard)
                ) {
                  services.forEach { servicePair ->
                    DropdownMenuItem(
                      text = { Text(servicePair.second, color = TextLight) },
                      onClick = {
                        selectedService = servicePair.first
                        showServiceDropdown = false
                      }
                    )
                  }
                }
              }

              Button(
                onClick = { restartService(selectedService) },
                enabled = !isActionRunning && !isRefreshing,
                colors = ButtonDefaults.buttonColors(containerColor = DuneOrange),
                shape = RoundedCornerShape(8.dp),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp)
              ) {
                Text("Restart")
              }
            }

            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
              Button(
                onClick = { triggerUpdate("check") },
                modifier = Modifier.weight(1f),
                enabled = !isActionRunning && !isRefreshing,
                colors = ButtonDefaults.buttonColors(containerColor = DuneDarkBackground),
                border = BorderStroke(1.dp, DuneOrange),
                shape = RoundedCornerShape(8.dp)
              ) {
                Text("Check Updates", color = DuneOrange)
              }

              Button(
                onClick = { triggerUpdate("install") },
                modifier = Modifier.weight(1f),
                enabled = !isActionRunning && !isRefreshing,
                colors = ButtonDefaults.buttonColors(containerColor = DuneDarkBackground),
                border = BorderStroke(1.dp, StatusYellow),
                shape = RoundedCornerShape(8.dp)
              ) {
                Text("Install Updates", color = StatusYellow)
              }
            }
          }
        }

        // Action Command Logs Console Output
        if (logOutput.isNotEmpty()) {
          Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = Color.Black),
            shape = RoundedCornerShape(12.dp)
          ) {
            Column(modifier = Modifier.padding(16.dp)) {
              Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
              ) {
                Text("Console Output", color = DuneYellow, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                Text(
                  text = "Clear",
                  color = TextMuted,
                  fontSize = 12.sp,
                  modifier = Modifier.clickable { logOutput = "" }
                )
              }
              Spacer(modifier = Modifier.height(8.dp))
              Text(
                text = logOutput,
                color = Color.Green,
                fontSize = 11.sp,
                fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                modifier = Modifier.fillMaxWidth()
              )
            }
          }
        }
      }
    }
  }
}
