import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";

export type GuardClass = "read" | "routine" | "guarded";

export interface Operation {
  name: string;
  label: string;
  description: string;
  aliases: string[];
  keywords: string[];
  resourceKind: string;
  verb: string;
  classification: GuardClass;
  parameters: TSchema;
  promptSnippet?: string;
}

export const viewParameters = Type.Object({
  target: Type.Optional(
    Type.String({
      description: "GitHub resource target: a URL, owner/repo, or omit for the current checkout",
    }),
  ),
  detail: Type.Optional(
    StringEnum(["compact", "expanded"], {
      description: "Projection detail. compact is the default.",
      default: "compact",
    }),
  ),
});

export const viewOperation: Operation = {
  name: "gh_view",
  label: "GitHub View",
  description: "Inspect a GitHub repository from a URL, owner/repo, or the current checkout.",
  aliases: ["view", "inspect"],
  keywords: ["repository", "repo", "url", "github"],
  resourceKind: "repository",
  verb: "view",
  classification: "read",
  parameters: viewParameters,
  promptSnippet: "Inspect a GitHub repository resource target",
};

export function createRegistry() {
  const operations = [viewOperation];
  return {
    operations,
    get(name: string) {
      return operations.find((operation) => operation.name === name);
    },
  };
}
