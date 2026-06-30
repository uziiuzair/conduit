import { StatusBar } from "expo-status-bar";
import React, { useState } from "react";
import { View } from "react-native";
import type { Agent } from "./src/data/types";
import { ChatScreen } from "./src/screens/ChatScreen";
import { ProjectsScreen } from "./src/screens/ProjectsScreen";
import { ThemeProvider, useTheme } from "./src/theme/ThemeContext";

type Nav = { screen: "projects" } | { screen: "chat"; agent: Agent };

function Root() {
  const { palette } = useTheme();
  const [nav, setNav] = useState<Nav>({ screen: "projects" });

  return (
    <View style={{ flex: 1, backgroundColor: palette.panelBg }}>
      <StatusBar style={palette.appearance === "dark" ? "light" : "dark"} />
      {nav.screen === "projects" ? (
        <ProjectsScreen onOpenAgent={(agent) => setNav({ screen: "chat", agent })} />
      ) : (
        <ChatScreen agent={nav.agent} onBack={() => setNav({ screen: "projects" })} />
      )}
    </View>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  );
}
