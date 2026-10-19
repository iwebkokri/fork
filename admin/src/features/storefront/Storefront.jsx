import React, { useEffect, useState } from "react";
import { Link, Route, Routes, useMatch } from "react-router-dom";
import AssistantChat from "./components/AssistantChat";
import CartPanel from "./components/CartPanel";
import Header, { LocationDialog } from "./components/Header";
import { Ri, SfConfirmProvider, ToastProvider } from "./components/ui";
import { SfAuthProvider } from "./lib/SfAuth";
import { SfNotifyBoundary } from "./lib/SfNotify";
import { SfCartProvider, useSfCart } from "./lib/SfCart";
import Checkout from "./pages/Checkout";
import Account from "./pages/Account";
import Handoff from "./pages/Handoff";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Notifications from "./pages/Notifications";
import Orders from "./pages/Orders";
import PayoutReturn from "./pages/PayoutReturn";
import Restaurant from "./pages/Restaurant";
import Track from "./pages/Track";
import Wallet from "./pages/Wallet";
import "./storefront.css";

function NotFound() {
  return (
    <div className="sf-container sf-narrow sf-center py-5">
      <Ri name="compass-3-line" className="sf-bigicon" />
      <h1 className="sf-h2 mt-2">Page not found</h1>
      <Link to="/order" className="sf-btn sf-btn-primary">Back to FORKSY</Link>
    </div>
  );
}

function Shell() {
  const [locOpen, setLocOpen] = useState(false);
  const [botOn, setBotOn] = useState(false);
  const { cart } = useSfCart();
  const restaurantMatch = useMatch("/order/r/:slug");
  const slug = restaurantMatch?.params?.slug ? decodeURIComponent(restaurantMatch.params.slug) : undefined;
  // the assistant is hidden on the sign-in / handoff / checkout screens where it would only get in the way
  const onHandoff = useMatch("/order/handoff");
  const onLogin = useMatch("/order/login");
  const hideBot = !!onHandoff || !!onLogin;

  useEffect(() => {
    const prev = document.title;
    document.title = "FORKSY - Order food online";
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <>
      <a href="#sf-main" className="sf-skip">Skip to content</a>
      <Header onLocation={() => setLocOpen(true)} />
      <main id="sf-main" className="sf-main">
        <Routes>
          <Route index element={<Home openAssistant={botOn ? () => window.dispatchEvent(new Event("sf:open-assistant")) : null} />} />
          <Route path="r/:slug" element={<Restaurant />} />
          <Route path="login" element={<Login />} />
          <Route path="handoff" element={<Handoff />} />
          <Route path="checkout" element={<Checkout />} />
          <Route path="track/:id" element={<Track />} />
          <Route path="orders" element={<Orders />} />
          <Route path="wallet" element={<Wallet />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="account" element={<Account />} />
          <Route path="payouts/return" element={<PayoutReturn />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <footer className="sf-footer">
        <div className="sf-container">
          <span>FORKSY - Mississauga, Brampton, Edmonton and Winnipeg</span>
          <span className="sf-muted">Payments by Stripe. Development site: test payments only.</span>
        </div>
      </footer>
      <CartPanel />
      <LocationDialog open={locOpen} onClose={() => setLocOpen(false)} />
      {!hideBot && <AssistantChat restaurantSlug={slug} lift={!!slug && cart.itemCount > 0} onAvailable={setBotOn} />}
    </>
  );
}

/**
 * Customer website, mounted by src/App.js at /order/*. Public layout: no admin sidebar, no admin session.
 * Own providers (toasts, confirm, customer auth, cart) and its own HTTP client / token store (see lib/sfApi.js).
 */
export default function Storefront() {
  return (
    <div className="sf" data-bs-theme="light">
      <ToastProvider>
        <SfConfirmProvider>
          <SfAuthProvider>
            <SfCartProvider>
              <SfNotifyBoundary>
                <Shell />
              </SfNotifyBoundary>
            </SfCartProvider>
          </SfAuthProvider>
        </SfConfirmProvider>
      </ToastProvider>
    </div>
  );
}
