type NotFoundProps = {
  loggedIn: boolean;
  onNavigate: (to: string, mode?: "push" | "replace") => void;
};

export function NotFound({ loggedIn, onNavigate }: NotFoundProps) {
  const handleClick = (href: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onNavigate(href, "push");
  };

  return (
    <section className="page-block">
      <h1>页面不存在</h1>
      <p>
        {loggedIn ? (
          <a href="/" onClick={handleClick("/")}>
            照片
          </a>
        ) : (
          <a href="/login" onClick={handleClick("/login")}>
            登录
          </a>
        )}
      </p>
    </section>
  );
}
