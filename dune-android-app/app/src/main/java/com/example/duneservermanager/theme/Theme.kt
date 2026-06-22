package com.example.duneservermanager.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val DarkColorScheme = darkColorScheme(
  primary = DuneOrange,
  secondary = DuneYellow,
  background = DuneDarkBackground,
  surface = DuneDarkCard,
  onPrimary = TextLight,
  onSecondary = DuneDarkBackground,
  onBackground = TextLight,
  onSurface = TextLight
)

@Composable
fun DuneServerManagerTheme(
  content: @Composable () -> Unit,
) {
  MaterialTheme(
    colorScheme = DarkColorScheme,
    typography = Typography,
    content = content
  )
}
