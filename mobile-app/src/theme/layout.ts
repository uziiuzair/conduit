import { Platform, StatusBar } from "react-native";

/** Lightweight safe-area insets without pulling in a native dep — fine for the
 * mock shell; swap for react-native-safe-area-context when we wire the bridge. */
export const TOP_INSET = Platform.OS === "ios" ? 54 : (StatusBar.currentHeight ?? 24) + 6;
export const BOTTOM_INSET = Platform.OS === "ios" ? 28 : 12;
