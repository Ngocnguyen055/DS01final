import { Icon } from "./Icon.tsx";

export function Avatar({
  name,
  online,
  group = false,
}: {
  name: string;
  online?: boolean;
  group?: boolean;
}) {
  const words = name.trim().split(/\s+/);
  const initials =
    words.length > 1
      ? `${words[0][0] || ""}${words.at(-1)?.[0] || ""}`
      : name.slice(0, 2);
  return (
    <span className={`avatar ${group ? "group-avatar" : ""}`}>
      {group ? <Icon name="users" /> : initials.toLocaleUpperCase()}
      {online !== undefined && <i className={online ? "online" : ""} />}
    </span>
  );
}
