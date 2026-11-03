const later = [
  '身份与 API Key',
  '个人库与对象存储',
  'EXIF、缩略图、描述与向量',
  '关键词与语义检索',
  '共享册、口令与角色',
  '完整网页',
];

export function App() {
  return (
    <main>
      <p className="eyebrow">PHASE 0 · 脚手架</p>
      <h1>OpenAlbum</h1>
      <p className="lede">
        人用网页管理照片，个人 Agent 用 API 做同一件事。这一页只说明前端工程已经接进仓库，业务界面要到 Phase 6 才替换这里的占位。
      </p>

      <section>
        <h2>现在可以用</h2>
        <ul className="available">
          <li>规格入口 specs/SPEC.md</li>
          <li>API 存活探针 GET /health</li>
          <li>部署占位 deploy/</li>
        </ul>
      </section>

      <section>
        <h2>尚未开始</h2>
        <ul className="pending">
          {later.map((item) => (
            <li key={item}>
              <span>{item}</span>
              <span>未开始</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
