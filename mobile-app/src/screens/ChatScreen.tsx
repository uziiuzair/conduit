import React, { useMemo, useRef, useState } from "react";
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
import { NeedsPill, ThemeButton } from "../components/atoms";
import { CHATS } from "../data/mock";
import type {
  Agent,
  ApprovalItem,
  BubbleItem,
  EventItem,
  TodosItem,
} from "../data/types";
import {
  appendAssistantReply,
  appendPrompt,
  groupFeed,
  pendingApproval,
  resolveApproval,
  type FeedRow,
} from "../logic/feed";
import { BOTTOM_INSET, TOP_INSET } from "../theme/layout";
import { useTheme } from "../theme/ThemeContext";

const mono = "Menlo";

const EVENT_GLYPH: Record<EventItem["event"], string> = {
  read: "📄",
  bash: "▶",
  edit: "✏️",
  search: "🔎",
  web: "🌐",
  subagent: "🧩",
  generic: "•",
};

interface Props {
  agent: Agent;
  onBack: () => void;
}

export function ChatScreen({ agent, onBack }: Props) {
  const { palette: p } = useTheme();
  const [feed, setFeed] = useState(() => CHATS[agent.id] ?? []);
  const [draft, setDraft] = useState("");
  const scroller = useRef<ScrollView>(null);

  const rows = useMemo(() => groupFeed(feed), [feed]);
  const hasPending = !!pendingApproval(feed);
  const showNeeds = agent.status === "needsInput" && (agent.pendingApproval ? hasPending : true);

  const scrollToEnd = () => requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: true }));

  const send = () => {
    const next = appendPrompt(feed, draft);
    if (next === feed) return;
    setFeed(next);
    setDraft("");
    scrollToEnd();
    setTimeout(() => {
      setFeed((f) => appendAssistantReply(f, "Got it — picking that up now."));
      scrollToEnd();
    }, 700);
  };

  const decide = (id: string, decision: "allow" | "deny") => {
    setFeed((f) => resolveApproval(f, id, decision));
    scrollToEnd();
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: p.panelBg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* header */}
      <View
        style={{
          paddingTop: TOP_INSET,
          paddingHorizontal: 12,
          paddingBottom: 11,
          backgroundColor: p.sidebarBg,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: p.border,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Pressable onPress={onBack} hitSlop={12} style={{ paddingRight: 2 }}>
          <Text style={{ color: p.textDim, fontSize: 24, lineHeight: 24 }}>‹</Text>
        </Pressable>
        <Text style={{ fontWeight: "600", fontSize: 15, color: p.textBright }}>{agent.name}</Text>
        <Text style={{ fontSize: 11, color: p.textMid, fontFamily: mono }}>{agent.branch}</Text>
        <View style={{ flex: 1 }} />
        {showNeeds && <NeedsPill />}
        <ThemeButton />
      </View>

      {/* feed */}
      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12, gap: 8 }}
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
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingTop: 9,
          paddingBottom: BOTTOM_INSET,
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
          style={{
            flex: 1,
            backgroundColor: p.panelBg,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: p.border,
            borderRadius: 18,
            paddingHorizontal: 13,
            paddingVertical: 9,
            color: p.textBright,
            fontSize: 14,
          }}
        />
        <Pressable
          onPress={send}
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            backgroundColor: p.accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: p.meText, fontSize: 16, fontWeight: "700" }}>↑</Text>
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
  const me = item.role === "user";
  return (
    <View
      style={{
        maxWidth: "82%",
        alignSelf: me ? "flex-end" : "flex-start",
        backgroundColor: me ? p.accent : p.selectionBg,
        borderRadius: 14,
        borderBottomRightRadius: me ? 4 : 14,
        borderBottomLeftRadius: me ? 14 : 4,
        paddingHorizontal: 12,
        paddingVertical: 9,
      }}
    >
      <Text style={{ color: me ? p.meText : p.textBright, fontSize: 13.5, lineHeight: 19, fontWeight: me ? "500" : "400" }}>
        {item.text}
      </Text>
    </View>
  );
}

function EventRail({ events }: { events: EventItem[] }) {
  const { palette: p } = useTheme();
  return (
    <View style={{ borderLeftWidth: 2, borderLeftColor: p.border, marginLeft: 6, paddingLeft: 11, gap: 6 }}>
      {events.map((e) => (
        <View key={e.id} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Text style={{ fontSize: 12 }}>{EVENT_GLYPH[e.event]}</Text>
          <Text style={{ fontSize: 11.5, color: p.textMid }}>{e.label}</Text>
          {e.mono && <Text style={{ fontSize: 11.5, color: p.textBright, fontFamily: mono }}>{e.mono}</Text>}
          {e.ok && <Text style={{ fontSize: 11.5, color: p.green, fontWeight: "600" }}>{e.ok}</Text>}
          <View style={{ flex: 1 }} />
          <Text style={{ color: p.textDim, fontSize: 13 }}>›</Text>
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
        borderRadius: 10,
        padding: 11,
        gap: 5,
      }}
    >
      <Text style={{ fontSize: 11.5, fontWeight: "700", color: p.textBright }}>
        To-dos · {item.done}/{item.total}
      </Text>
      {item.items.map((t, i) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Text style={{ color: color(t.status), fontSize: 12, width: 14 }}>{icon(t.status)}</Text>
          <Text
            style={{
              fontSize: 11.5,
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
          borderRadius: 8,
          paddingHorizontal: 11,
          paddingVertical: 8,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Text style={{ color: allowed ? p.green : p.red, fontWeight: "700" }}>{allowed ? "✓" : "✕"}</Text>
        <Text style={{ color: p.textMid, fontSize: 11.5 }}>
          {allowed ? "Approved" : "Denied"} · {item.tool}
        </Text>
        <Text style={{ color: p.textDim, fontSize: 11, fontFamily: mono, flexShrink: 1 }} numberOfLines={1}>
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
        borderRadius: 9,
        padding: 11,
        gap: 9,
      }}
    >
      <Text style={{ color: p.pillNeedsText, fontWeight: "700", fontSize: 12 }}>
        ⚠︎ Approval needed · {item.tool}
      </Text>
      <View
        style={{
          backgroundColor: p.panelBg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: p.border,
          borderRadius: 6,
          paddingHorizontal: 9,
          paddingVertical: 7,
        }}
      >
        <Text style={{ color: p.textBright, fontFamily: mono, fontSize: 12 }}>{item.input}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable
          onPress={() => onDecide(item.id, "deny")}
          style={{
            flex: 1,
            alignItems: "center",
            paddingVertical: 9,
            borderRadius: 8,
            backgroundColor: p.selectionBg,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: p.border,
          }}
        >
          <Text style={{ color: p.red, fontWeight: "700", fontSize: 13 }}>Deny</Text>
        </Pressable>
        <Pressable
          onPress={() => onDecide(item.id, "allow")}
          style={{ flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: 8, backgroundColor: p.green }}
        >
          <Text style={{ color: p.onGreen, fontWeight: "700", fontSize: 13 }}>Approve</Text>
        </Pressable>
      </View>
    </View>
  );
}
