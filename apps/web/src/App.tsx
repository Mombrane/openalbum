const phases = [
  { id: "1", name: "身份与 API Key", state: "未开始" },
  { id: "2", name: "个人库与对象存储", state: "未开始" },
  { id: "3", name: "EXIF、缩略图、描述与向量", state: "未开始" },
  { id: "4", name: "关键词与语义检索", state: "未开始" },
  { id: "5", name: "共享册、口令与角色", state: "未开始" },
  { id: "6", name: "完整网页", state: "未开始" },
];

export function App() {
  return (
    <main>
      <p className="eyebrow">Phase 0 · 脚手架</p>
      <h1>AI Native 共享相册</h1>
      <p className="lead">
        人用网页管理照片，个人 Agent 用 API 做同一件事。这一页只说明前端工程已经接进仓库，业务界面要到
        Phase 6 才替换这里的占位。
      </p>

      <section>
        <h2>现在可以用</h2>
        <ul>
          <li>
            规格入口 <code>specs/SPEC.md</code>
          </li>
          <li>
            API 存活探针 <code>GET /health</code>
          </li>
          <li>
            部署占位 <code>deploy/</code>
          </li>
        </ul>
      </section>

      <section>
        <h2>尚未开始</h2>
        <ol>
          {phases.map((phase) => (
            <li key={phase.id}>
              <span>{phase.name}</span>
              <span className="state">{phase.state}</span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
