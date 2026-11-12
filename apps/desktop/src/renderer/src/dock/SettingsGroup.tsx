import type { ReactNode } from "react";

/**
 * 系统设置里的一组设置：小标题 + 若干设置行。
 *
 * 分组承担原来「大标题 + 分隔线」的角色，所以组内第一行不再画上边线，
 * 组与组之间靠更大的外边距拉开（见 styles-launcher.css 的 .launcher-settings-group）。
 */
export default function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="launcher-settings-group" aria-label={title}>
      <div className="appearance-section-head appearance-section-head--first">{title}</div>
      <div className="launcher-settings-rows">{children}</div>
    </section>
  );
}
