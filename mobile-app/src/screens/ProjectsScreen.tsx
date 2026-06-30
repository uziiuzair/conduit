import React, { useCallback, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar, NeedsPill, StatusDot, ThemeButton } from "../components/atoms";
import { SwipeableRow } from "../components/SwipeableRow";
import { PROJECTS } from "../data/mock";
import type { Agent } from "../data/types";
import { agentBadge, agentSubline, needsCount, statusDot } from "../logic/status";
import type { ProjectsProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, MONO, TYPE } from "../theme/type";

export function ProjectsScreen({ navigation }: ProjectsProps) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const [projects, setProjects] = useState(PROJECTS);
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
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 5, gap: 6 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.green }} />
            <Text style={{ fontSize: TYPE.footnote, color: p.textDim }}>paired · this Mac · 12:04</Text>
          </View>
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
