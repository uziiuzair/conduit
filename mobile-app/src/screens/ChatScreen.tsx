import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Markdown from "react-native-markdown-display";
import { useLive } from "../bridge/LiveProvider";
import { NeedsPill, ThemeButton } from "../components/atoms";
import type { ApprovalItem, BubbleItem, EventItem, TodosItem } from "../data/types";
import { groupFeed, type FeedRow } from "../logic/feed";
import type { ChatProps } from "../navigation";
import type { Palette } from "../theme/palettes";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, MONO, TYPE } from "../theme/type";

const EVENT_GLYPH: Record<EventItem["event"], string> = {
  read: "📄",
  bash: "▶",
  edit: "✏️",
  search: "🔎",
  web: "🌐",
  subagent: "🧩",
  generic: "•",
};

export function ChatScreen({ route, navigation }: ChatProps) {
  const { agent } = route.params;
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const { sessionLive, attach, detach, prompt } = useLive();
  const [draft, setDraft] = useState("");
  const scroller = useRef<ScrollView>(null);

  // Attach to this session's live stream (transcript history + tail + status)
  // while the screen is mounted; detach on leave.
  useEffect(() => {
    attach(agent.id);
    return () => detach();
  }, [agent.id, attach, detach]);

  const feed = sessionLive.feed;
  const rows = useMemo(() => groupFeed(feed), [feed]);
  const showNeeds = sessionLive.status === "needsInput";

  const scrollToEnd = () => requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: true }));

  const send = () => {
    if (!draft.trim()) return;
    prompt(agent.id, draft); // optimistic echo + write to the live PTY
    setDraft("");
    scrollToEnd();
  };

  const decide = (_id: string, _decision: "allow" | "deny") => {
    // approvals arrive via the broker (a later phase); no-op in the read channel
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: p.panelBg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* header */}
      <View
        style={{
          paddingTop: insets.top + 6,
          paddingHorizontal: 8,
          paddingBottom: 10,
          backgroundColor: p.sidebarBg,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: p.border,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
        }}
      >
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={8}
          style={{ width: 40, height: MIN_TOUCH, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ color: p.accent, fontSize: 30, lineHeight: 30 }}>‹</Text>
        </Pressable>
        <Text style={{ fontWeight: "600", fontSize: TYPE.headline, color: p.textBright }}>{agent.name}</Text>
        <Text style={{ fontSize: TYPE.footnote, color: p.textMid, fontFamily: MONO }}>{agent.branch}</Text>
        <View style={{ flex: 1 }} />
        {showNeeds ? (
          <NeedsPill />
        ) : sessionLive.status === "running" && sessionLive.activity ? (
          <Text style={{ fontSize: TYPE.caption, color: p.textMid, maxWidth: 130 }} numberOfLines={1}>
            {sessionLive.activity}
          </Text>
        ) : null}
        <ThemeButton />
      </View>

      {/* feed */}
      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12, gap: 9 }}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={scrollToEnd}
      >
        {rows.map((row) => (
          <FeedRowView key={rowKey(row)} row={row} onDecide={decide} />
        ))}
      </ScrollView>

      {/* composer */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 8,
          paddingHorizontal: 12,
          paddingTop: 9,
          paddingBottom: insets.bottom + 8,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: p.border,
          backgroundColor: p.sidebarBg,
        }}
      >
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={`Reply to ${agent.name}…`}
          placeholderTextColor={p.textDim}
          onSubmitEditing={send}
          returnKeyType="send"
          multiline
          style={{
            flex: 1,
            minHeight: MIN_TOUCH,
            maxHeight: 120,
            backgroundColor: p.panelBg,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: p.border,
            borderRadius: 20,
            paddingHorizontal: 15,
            paddingVertical: 11,
            color: p.textBright,
            fontSize: TYPE.body,
          }}
        />
        <Pressable
          onPress={send}
          style={{
            width: MIN_TOUCH,
            height: MIN_TOUCH,
            borderRadius: MIN_TOUCH / 2,
            backgroundColor: p.accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: p.meText, fontSize: 20, fontWeight: "700" }}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function rowKey(row: FeedRow): string {
  return row.type === "events" ? row.id : row.item.id;
}

function FeedRowView({
  row,
  onDecide,
}: {
  row: FeedRow;
  onDecide: (id: string, d: "allow" | "deny") => void;
}) {
  if (row.type === "events") return <EventRail events={row.events} />;
  const item = row.item;
  switch (item.kind) {
    case "bubble":
      return <Bubble item={item} />;
    case "todos":
      return <TodosCard item={item} />;
    case "approval":
      return <ApprovalCard item={item} onDecide={onDecide} />;
  }
}

function Bubble({ item }: { item: BubbleItem }) {
  const { palette: p } = useTheme();
  if (item.role === "user") {
    return (
      <View
        style={{
          maxWidth: "84%",
          alignSelf: "flex-end",
          backgroundColor: p.accent,
          borderRadius: 16,
          borderBottomRightRadius: 5,
          paddingHorizontal: 14,
          paddingVertical: 10,
        }}
      >
        <Text style={{ color: p.meText, fontSize: TYPE.callout, lineHeight: 22, fontWeight: "500" }}>
          {item.text}
        </Text>
      </View>
    );
  }
  // assistant — render Markdown (bold/lists/code/tables); wider for long-form content
  return (
    <View
      style={{
        maxWidth: "94%",
        alignSelf: "flex-start",
        backgroundColor: p.selectionBg,
        borderRadius: 16,
        borderBottomLeftRadius: 5,
        paddingHorizontal: 14,
        paddingVertical: 4,
      }}
    >
      <Markdown style={mdStyles(p)}>{item.text}</Markdown>
    </View>
  );
}

/** Markdown theme matching the active palette (react-native-markdown-display). */
function mdStyles(p: Palette) {
  const codeBox = {
    backgroundColor: p.panelBg,
    color: p.textBright,
    fontFamily: MONO,
    fontSize: TYPE.footnote,
    padding: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: p.border,
  };
  return {
    body: { color: p.textBright, fontSize: TYPE.callout, lineHeight: 22 },
    heading1: { color: p.textBright, fontSize: 22, fontWeight: "700" as const, marginTop: 6, marginBottom: 4 },
    heading2: { color: p.textBright, fontSize: TYPE.headline, fontWeight: "700" as const, marginTop: 6, marginBottom: 3 },
    heading3: { color: p.textBright, fontSize: TYPE.callout, fontWeight: "700" as const, marginTop: 4, marginBottom: 2 },
    strong: { fontWeight: "700" as const, color: p.textBright },
    em: { fontStyle: "italic" as const },
    link: { color: p.accent },
    bullet_list: { marginVertical: 2 },
    ordered_list: { marginVertical: 2 },
    list_item: { marginVertical: 1 },
    code_inline: {
      backgroundColor: p.panelBg,
      color: p.accent,
      fontFamily: MONO,
      fontSize: TYPE.footnote,
      borderRadius: 4,
      paddingHorizontal: 4,
    },
    code_block: codeBox,
    fence: codeBox,
    blockquote: { backgroundColor: p.panelBg, borderLeftColor: p.accent, borderLeftWidth: 3, paddingHorizontal: 10 },
    table: { borderColor: p.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, marginVertical: 4 },
    th: { padding: 6, color: p.textBright, fontWeight: "700" as const },
    td: { padding: 6, color: p.textBright },
    tr: { borderColor: p.border, borderBottomWidth: StyleSheet.hairlineWidth },
    hr: { backgroundColor: p.border, height: StyleSheet.hairlineWidth, marginVertical: 6 },
  };
}

function EventRail({ events }: { events: EventItem[] }) {
  const { palette: p } = useTheme();
  return (
    <View style={{ borderLeftWidth: 2, borderLeftColor: p.border, marginLeft: 6, paddingLeft: 12, gap: 8 }}>
      {events.map((e) => (
        <View key={e.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 14 }}>{EVENT_GLYPH[e.event]}</Text>
          <Text style={{ fontSize: TYPE.footnote, color: p.textMid }}>{e.label}</Text>
          {e.mono && <Text style={{ fontSize: TYPE.footnote, color: p.textBright, fontFamily: MONO }}>{e.mono}</Text>}
          {e.ok && <Text style={{ fontSize: TYPE.footnote, color: p.green, fontWeight: "600" }}>{e.ok}</Text>}
          <View style={{ flex: 1 }} />
          <Text style={{ color: p.textDim, fontSize: 15 }}>›</Text>
        </View>
      ))}
    </View>
  );
}

function TodosCard({ item }: { item: TodosItem }) {
  const { palette: p } = useTheme();
  const icon = (s: TodosItem["items"][number]["status"]) =>
    s === "completed" ? "✓" : s === "in_progress" ? "◐" : "○";
  const color = (s: TodosItem["items"][number]["status"]) =>
    s === "completed" ? p.green : s === "in_progress" ? p.accent : p.textDim;
  return (
    <View
      style={{
        backgroundColor: p.sidebarBg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: p.border,
        borderRadius: 12,
        padding: 13,
        gap: 7,
      }}
    >
      <Text style={{ fontSize: TYPE.subhead, fontWeight: "700", color: p.textBright }}>
        To-dos · {item.done}/{item.total}
      </Text>
      {item.items.map((t, i) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>
          <Text style={{ color: color(t.status), fontSize: 15, width: 16 }}>{icon(t.status)}</Text>
          <Text
            style={{
              fontSize: TYPE.subhead,
              color: t.status === "pending" ? p.textMid : p.textBright,
              textDecorationLine: t.status === "completed" ? "line-through" : "none",
            }}
          >
            {t.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ApprovalCard({
  item,
  onDecide,
}: {
  item: ApprovalItem;
  onDecide: (id: string, d: "allow" | "deny") => void;
}) {
  const { palette: p } = useTheme();

  if (item.resolved) {
    const allowed = item.resolved === "allow";
    return (
      <View
        style={{
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: p.border,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 10,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Text style={{ color: allowed ? p.green : p.red, fontWeight: "700", fontSize: TYPE.callout }}>
          {allowed ? "✓" : "✕"}
        </Text>
        <Text style={{ color: p.textMid, fontSize: TYPE.footnote }}>
          {allowed ? "Approved" : "Denied"} · {item.tool}
        </Text>
        <Text style={{ color: p.textDim, fontSize: TYPE.footnote, fontFamily: MONO, flexShrink: 1 }} numberOfLines={1}>
          {item.input}
        </Text>
      </View>
    );
  }

  return (
    <View
      style={{
        backgroundColor: p.pillNeedsBg,
        borderWidth: 1,
        borderColor: p.amber,
        borderLeftWidth: 3,
        borderRadius: 11,
        padding: 13,
        gap: 11,
      }}
    >
      <Text style={{ color: p.pillNeedsText, fontWeight: "700", fontSize: TYPE.callout }}>
        ⚠︎ Approval needed · {item.tool}
      </Text>
      <View
        style={{
          backgroundColor: p.panelBg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: p.border,
          borderRadius: 8,
          paddingHorizontal: 11,
          paddingVertical: 9,
        }}
      >
        <Text style={{ color: p.textBright, fontFamily: MONO, fontSize: TYPE.subhead }}>{item.input}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Pressable
          onPress={() => onDecide(item.id, "deny")}
          style={{
            flex: 1,
            minHeight: MIN_TOUCH,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            backgroundColor: p.selectionBg,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: p.border,
          }}
        >
          <Text style={{ color: p.red, fontWeight: "700", fontSize: TYPE.callout }}>Deny</Text>
        </Pressable>
        <Pressable
          onPress={() => onDecide(item.id, "allow")}
          style={{
            flex: 1,
            minHeight: MIN_TOUCH,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            backgroundColor: p.green,
          }}
        >
          <Text style={{ color: p.onGreen, fontWeight: "700", fontSize: TYPE.callout }}>Approve</Text>
        </Pressable>
      </View>
    </View>
  );
}
