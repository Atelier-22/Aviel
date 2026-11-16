const $ = (id) => document.getElementById(id);

async function show() {
  const c = await window.assist.config();
  $("server").value = c.apiUrl;
  $("keys").textContent = c.hotkey;
  $("signin").style.display = c.signedIn ? "none" : "block";
  $("done").style.display = c.signedIn ? "block" : "none";
}

$("go").addEventListener("click", async () => {
  $("err").textContent = "";
  $("go").disabled = true;
  const r = await window.assist.signIn({ email: $("email").value.trim(), password: $("password").value, server: $("server").value.trim() });
  $("go").disabled = false;
  if (!r.ok) return ($("err").textContent = r.error);
  $("hello").textContent = r.name ? `You're set, ${r.name.split(" ")[0]}.` : "You're set.";
  show();
});

$("password").addEventListener("keydown", (e) => e.key === "Enter" && $("go").click());
$("out").addEventListener("click", async () => { await window.assist.signOut(); show(); });
show();
