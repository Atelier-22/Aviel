// Shows where to look: a pulsing marker with a label, for a few seconds.
let timer = null;
window.assist.onPointer(({ x, y, label }) => {
  const spot = document.getElementById("spot");
  spot.style.left = `${x}px`;
  spot.style.top = `${y}px`;
  const tag = document.getElementById("label");
  tag.textContent = label || "";
  tag.style.display = label ? "block" : "none";
  // Labels near the right edge go on the left of the marker.
  tag.style.left = x > window.innerWidth - 260 ? "auto" : "30px";
  tag.style.right = x > window.innerWidth - 260 ? "30px" : "auto";
  spot.style.display = "block";
  clearTimeout(timer);
  timer = setTimeout(() => (spot.style.display = "none"), 6000);
});
