import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import { Avatar, NeedsPill, StatusDot, ThemeButton } from "../components/atoms";
import { SwipeableRow } from "../components/SwipeableRow";
import type { Agent, Project } from "../data/types";
import { agentBadge, agentSubline, needsCount, statusDot } from "../logic/status";
import type { ProjectsProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, MONO, TYPE } from "../theme/type";

export function ProjectsScreen({ navigation }: ProjectsProps) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const { projects: liveProjects, connState, url, setUrl, token, setToken } = useLive();
  // local copy so swipe Rename/Delete stay optimistic; re-synced on each live update
  const [projects, setProjects] = useState<Project[]>(liveProjects);
  useEffect(() => setProjects(liveProjects), [liveProjects]);

  const editUrl = () => {
    Alert.prompt(
      "Desktop bridge URL",
      "ws://127.0.0.1:8455 (dev) or :8456 (alongside installed). From a real phone: ws://<mac-LAN-IP>:<port>",
      (text) => {
        const u = text?.trim();
        if (u) setUrl(u);
        // then the dev shared token; blank = loopback (no gate)
        Alert.prompt(
          "Bridge token",
          "Blank for loopback. On a real phone: the CONDUIT_BRIDGE_TOKEN you launched the desktop with.",
          (t) => setToken((t ?? "").trim()),
          "plain-text",
          token,
        );
      },
      "plain-text",
      url,
    );
  };
  const totalNeeds = projects.reduce((n, proj) => n + needsCount(proj.agents), 0);

  // pull-to-refresh (simulated in the shell)
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 900);
  }, []);

  const renameAgent = (projId: string, agent: Agent) => {
    Alert.prompt(
      "Rename session",
      undefined,
      (text) => {
        const name = text?.trim();
        if (!name) return;
        setProjects((ps) =>
          ps.map((pr) =>
            pr.id !== projId
              ? pr
              : { ...pr, agents: pr.agents.map((a) => (a.id === agent.id ? { ...a, name } : a)) },
          ),
        );
      },
      "plain-text",
      agent.name,
    );
  };

  const deleteAgent = (projId: string, agent: Agent) => {
    Alert.alert("Delete session", `Remove “${agent.name}” from the list?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          setProjects((ps) =>
            ps.map((pr) =>
              pr.id !== projId ? pr : { ...pr, agents: pr.agents.filter((a) => a.id !== agent.id) },
            ),
          ),
      },
    ]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBg }}>
      {/* header */}
      <View
        style={{
          paddingTop: insets.top + 8,
          paddingHorizontal: 16,
          paddingBottom: 12,
          backgroundColor: p.sidebarBg,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: p.border,
          flexDirection: "row",
          alignItems: "flex-end",
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: TYPE.title, fontWeight: "700", color: p.textBright }}>Projects</Text>
          <Pressable
            onPress={editUrl}
            hitSlop={8}
            style={{ flexDirection: "row", alignItems: "center", marginTop: 5, gap: 6 }}
          >
            <View
              style={{
                width: 7,
                height: 7,
                borderRadius: 4,
                backgroundColor: connState === "open" ? p.green : connState === "connecting" ? p.amber : p.red,
              }}
            />
            <Text style={{ fontSize: TYPE.footnote, color: p.textDim }}>
              {connState === "open"
                ? "connected · desktop bridge"
                : connState === "connecting"
                  ? "connecting…"
                  : "disconnected · tap to set URL"}
            </Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {totalNeeds > 0 && <NeedsPill label={`${totalNeeds} need you`} />}
          <ThemeButton />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={p.accent} colors={[p.accent]} />
        }
      >
        {projects.length === 0 && (
          <View style={{ padding: 40, alignItems: "center" }}>
            <Text style={{ color: p.textDim, fontSize: TYPE.subhead, textAlign: "center" }}>
              {connState === "open" ? "No projects on the desktop yet." : "Waiting for the desktop bridge…"}
            </Text>
          </View>
        )}
        {projects.map((proj) => (
          <View key={proj.id}>
            {/* project section header */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "baseline",
                paddingHorizontal: 16,
                paddingTop: 18,
                paddingBottom: 6,
              }}
            >
              <Text
                style={{
                  fontSize: TYPE.footnote,
                  fontWeight: "700",
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                  color: p.textMid,
                  flex: 1,
                }}
              >
                {proj.name}
              </Text>
              <Text style={{ fontSize: TYPE.caption, color: p.textDim, fontFamily: MONO }}>{proj.path}</Text>
            </View>

            {proj.agents.map((agent) => (
              <SwipeableRow
                key={agent.id}
                onRename={() => renameAgent(proj.id, agent)}
                onDelete={() => deleteAgent(proj.id, agent)}
              >
                <AgentRow agent={agent} onPress={() => navigation.navigate("Chat", { agent })} />
              </SwipeableRow>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function AgentRow({ agent, onPress }: { agent: Agent; onPress: () => void }) {
  const { palette: p } = useTheme();
  const dot = statusDot(agent);
  const isNeeds = agent.status === "needsInput";

  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: p.selectionBg }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: MIN_TOUCH + 16,
        paddingVertical: 12,
        paddingRight: 14,
        paddingLeft: isNeeds ? 13 : 16,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: p.border,
        borderLeftWidth: isNeeds ? 3 : 0,
        borderLeftColor: p.amber,
        backgroundColor: pressed ? p.selectionBg : isNeeds ? p.needsBg : p.panelBg,
      })}
    >
      <Avatar letter={agentBadge(agent.kind)} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Text style={{ fontSize: TYPE.headline, fontWeight: "600", color: p.textBright }}>{agent.name}</Text>
          <Text style={{ fontSize: TYPE.footnote, color: p.textMid, fontFamily: MONO }}>{agent.branch}</Text>
        </View>
        <Text
          numberOfLines={1}
          style={{
            fontSize: TYPE.footnote,
            marginTop: 3,
            color: isNeeds ? p.pillNeedsText : p.textMid,
          }}
        >
          {agentSubline(agent)}
        </Text>
      </View>

      <View style={{ alignItems: "flex-end", gap: 4 }}>
        {isNeeds ? (
          <NeedsPill />
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
            {agent.todos && (
              <Text style={{ fontSize: TYPE.caption, color: p.textMid, fontFamily: MONO }}>
                {agent.todos.done}/{agent.todos.total}
              </Text>
            )}
            <StatusDot kind={dot} />
          </View>
        )}
      </View>
    </Pressable>
  );
}
