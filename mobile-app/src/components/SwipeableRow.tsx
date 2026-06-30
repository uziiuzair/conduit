import React, { useRef } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { useTheme } from "../theme/ThemeContext";
import { TYPE } from "../theme/type";

const ACTION_W = 84;

interface Props {
  children: React.ReactNode;
  onRename: () => void;
  onDelete: () => void;
}

/**
 * iOS Mail-style swipe-left-to-reveal row. The "parallax" is an interpolation
 * trick: each action's translateX is driven by the swipe `progress` (0→1) with a
 * different resting offset, so Rename and Delete slide in at different rates than
 * the card — giving the layered, depth-y reveal.
 */
export function SwipeableRow({ children, onRename, onDelete }: Props) {
  const { palette: p } = useTheme();
  const ref = useRef<Swipeable>(null);
  const total = ACTION_W * 2;

  const action = (
    label: string,
    bg: string,
    fg: string,
    restingOffset: number,
    progress: Animated.AnimatedInterpolation<number>,
    onPress: () => void,
  ) => {
    const translateX = progress.interpolate({
      inputRange: [0, 1],
      outputRange: [restingOffset, 0],
      extrapolate: "clamp",
    });
    return (
      <Animated.View key={label} style={{ flex: 1, transform: [{ translateX }] }}>
        <Pressable
          onPress={() => {
            ref.current?.close();
            onPress();
          }}
          style={{ flex: 1, backgroundColor: bg, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ color: fg, fontWeight: "700", fontSize: TYPE.footnote }}>{label}</Text>
        </Pressable>
      </Animated.View>
    );
  };

  const renderRightActions = (progress: Animated.AnimatedInterpolation<number>) => (
    <View style={{ width: total, flexDirection: "row" }}>
      {/* Rename rests furthest right (full width) → travels most → reads as "behind" */}
      {action("Rename", p.selectionBg, p.accent, total, progress, onRename)}
      {/* Delete rests one slot in → travels less → reads as "on top" */}
      {action("Delete", p.red, "#ffffff", ACTION_W, progress, onDelete)}
    </View>
  );

  return (
    <Swipeable
      ref={ref}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={renderRightActions}
    >
      {children}
    </Swipeable>
  );
}
