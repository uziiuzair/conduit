import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  type Theme,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import React from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LiveProvider } from "./src/bridge/LiveProvider";
import type { RootStackParamList } from "./src/navigation";
import { ChatScreen } from "./src/screens/ChatScreen";
import { ProjectsScreen } from "./src/screens/ProjectsScreen";
import { ThemeProvider, useTheme } from "./src/theme/ThemeContext";

const Stack = createNativeStackNavigator<RootStackParamList>();

function Inner() {
  const { palette } = useTheme();
  const base = palette.appearance === "dark" ? DarkTheme : DefaultTheme;
  const navTheme: Theme = {
    ...base,
    colors: {
      ...base.colors,
      background: palette.panelBg,
      card: palette.sidebarBg,
      text: palette.textBright,
      border: palette.border,
      primary: palette.accent,
    },
  };

  return (
    <NavigationContainer theme={navTheme}>
      <StatusBar style={palette.appearance === "dark" ? "light" : "dark"} />
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          // native iOS edge-swipe-back, extended to the full screen width
          gestureEnabled: true,
          fullScreenGestureEnabled: true,
          contentStyle: { backgroundColor: palette.panelBg },
        }}
      >
        <Stack.Screen name="Projects" component={ProjectsScreen} />
        <Stack.Screen name="Chat" component={ChatScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <LiveProvider>
            <Inner />
          </LiveProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
