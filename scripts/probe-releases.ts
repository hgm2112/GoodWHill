import { fetchUpcomingReleases } from "@/lib/releases";

async function main() {
  const r = await fetchUpcomingReleases();
  console.log("errors:", r.errors);
  console.log("count:", r.releases.length);
  for (const x of r.releases) {
    console.log(
      (x.date ?? "TBA").padEnd(12),
      x.label.padEnd(12),
      x.name.slice(0, 55).padEnd(56),
      x.url ?? "",
    );
  }
}

main();
