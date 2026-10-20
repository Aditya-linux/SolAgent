import { DataProvider } from "./data.tsx";
import { ToastProvider } from "./toast.tsx";
import { Shell } from "./components/Shell.tsx";
import { useRoute } from "./lib/router.ts";
import { Dashboard } from "./pages/Dashboard.tsx";
import { EventDetail } from "./pages/EventDetail.tsx";
import { History } from "./pages/History.tsx";
import { Notifications } from "./pages/Notifications.tsx";
import { PlanNew } from "./pages/PlanNew.tsx";
import { Support } from "./pages/Support.tsx";
import { Wallet } from "./pages/Wallet.tsx";

function Screen() {
  const route = useRoute();
  const [section, id] = route.segments;

  let page;
  switch (section) {
    case "event":
      page = id ? <EventDetail key={id} tripId={id} route={route} /> : <Dashboard route={route} />;
      break;
    case "new":
      page = <PlanNew />;
      break;
    case "wallet":
      page = <Wallet />;
      break;
    case "history":
      page = <History />;
      break;
    case "notifications":
      page = <Notifications />;
      break;
    case "support":
      page = <Support />;
      break;
    default:
      page = <Dashboard route={route} />;
  }
  return <Shell route={route}>{page}</Shell>;
}

export function App() {
  return (
    <ToastProvider>
      <DataProvider>
        <Screen />
      </DataProvider>
    </ToastProvider>
  );
}
