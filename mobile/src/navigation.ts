import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Agent } from "./data/types";

export type RootStackParamList = {
  Projects: undefined;
  Chat: { agent: Agent };
};

export type ProjectsProps = NativeStackScreenProps<RootStackParamList, "Projects">;
export type ChatProps = NativeStackScreenProps<RootStackParamList, "Chat">;
