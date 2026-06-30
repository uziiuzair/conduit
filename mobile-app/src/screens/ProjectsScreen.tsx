import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Avatar, NeedsPill, StatusDot, ThemeButton } from "../components/atoms";
import { PROJECTS } from "../data/mock";
import type { Agent } from "../data/types";
import { agentBadge, agentSubline, needsCount, statusDot } from "../logic/status";
import { TOP_INSET } from "../theme/layout";
import { useTheme } from "../theme/ThemeContext";

interface Props {
  onOpenAgent: (agent: Agent) => void;
}

export function ProjectsScreen({ onOpenAgent }: Props) {
  const { palette: p } = useTheme();
  const totalNeeds = PROJECTS.reduce((n, proj) => n + needsCount(proj.agents), 0);

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBg }}>
      {/* header */}
      <View
        style={{
          paddingTop: TOP_INSET,
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
          <Text style={{ fontSize: 22, fontWeight: "700", color: p.textBright }}>Projects</Text>
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4, gap: 6 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.green }} />
            <Text style={{ fontSize: 11, color: p.textDim }}>paired · this Mac · 12:04</Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {totalNeeds > 0 && <NeedsPill label={`${totalNeeds} need you`} />}
          <ThemeButton />
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {PROJECTS.map((proj) => (
          <View key={proj.id}>
            {/* project section header */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "baseline",
                paddingHorizontal: 16,
                paddingTop: 16,
                paddingBottom: 6,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: "700",
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                  color: p.textMid,
                  flex: 1,
                }}
              >
                {proj.name}
              </Text>
              <Text style={{ fontSize: 10, color: p.textDim, fontFamily: mono }}>{proj.path}</Text>
            </View>

            {proj.agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} onPress={() => onOpenAgent(agent)} />
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
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 11,
        paddingVertical: 11,
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
          <Text style={{ fontSize: 13, fontWeight: "600", color: p.textBright }}>{agent.name}</Text>
          <Text style={{ fontSize: 10.5, color: p.textMid, fontFamily: mono }}>{agent.branch}</Text>
        </View>
        <Text
          numberOfLines={1}
          style={{
            fontSize: 11,
            marginTop: 2,
            color: isNeeds ? p.pillNeedsText : p.textMid,
          }}
        >
          {agentSubline(agent)}
        </Text>
      </View>

      <View style={{ alignItems: "flex-end", gap: 3 }}>
        {isNeeds ? (
          <NeedsPill />
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {agent.todos && (
              <Text style={{ fontSize: 10, color: p.textMid, fontFamily: mono }}>
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

const mono = "Menlo";
