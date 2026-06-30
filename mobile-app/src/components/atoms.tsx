import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { DotKind } from "../logic/status";
import { PALETTES, THEME_ORDER } from "../theme/palettes";
import { useTheme } from "../theme/ThemeContext";

/** Three-swatch control that cycles the Warm schemes; active one is ringed. */
export function ThemeButton() {
  const { themeId, cycle } = useTheme();
  return (
    <Pressable
      onPress={cycle}
      hitSlop={10}
      accessibilityLabel="Switch theme"
      style={{ flexDirection: "row", gap: 4, alignItems: "center", paddingVertical: 6, paddingLeft: 6 }}
    >
      {THEME_ORDER.map((id) => {
        const active = id === themeId;
        return (
          <View
            key={id}
            style={{
              width: active ? 13 : 10,
              height: active ? 13 : 10,
              borderRadius: 7,
              backgroundColor: PALETTES[id].accent,
              borderWidth: active ? 1.5 : StyleSheet.hairlineWidth,
              borderColor: active ? PALETTES[id].textBright : PALETTES[id].border,
            }}
          />
        );
      })}
    </Pressable>
  );
}

/** Square letter avatar for an agent kind (C / X / G). */
export function Avatar({ letter }: { letter: string }) {
  const { palette: p } = useTheme();
  return (
    <View
      style={{
        width: 30,
        height: 30,
        borderRadius: 9,
        backgroundColor: p.selectionBg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: p.accent, fontWeight: "700", fontSize: 14 }}>{letter}</Text>
    </View>
  );
}

/** Amber "needs you" pill. */
export function NeedsPill({ label = "needs you" }: { label?: string }) {
  const { palette: p } = useTheme();
  return (
    <View
      style={{
        backgroundColor: p.pillNeedsBg,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 20,
      }}
    >
      <Text style={{ color: p.pillNeedsText, fontSize: 10, fontWeight: "700" }}>{label}</Text>
    </View>
  );
}

/** Status dot mirroring the desktop sidebar accessory. */
export function StatusDot({ kind }: { kind: DotKind }) {
  const { palette: p } = useTheme();
  if (kind === "idle") {
    return (
      <View
        style={{ width: 9, height: 9, borderRadius: 5, borderWidth: 1.5, borderColor: p.textDim }}
      />
    );
  }
  const bg = kind === "running" || kind === "done" ? p.green : p.amber;
  return (
    <View
      style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: bg, opacity: kind === "done" ? 0.85 : 1 }}
    />
  );
}
