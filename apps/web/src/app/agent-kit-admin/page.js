// 宿主 admin 管理控制台（Server Component 装配）：渲染 agent-kit 的 AdminConsole
// （client 组件），左侧树状菜单（基本设置 / 算力统筹 / 用户反馈），设置落库并暴露 API。
import { AdminConsole } from "@turingflow/agent-kit/ui";

export default function AdminPage() {
  return <AdminConsole basePath="/linger" />;
}
