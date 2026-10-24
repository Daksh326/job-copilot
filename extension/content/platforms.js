// Per-platform page knowledge. READ-ONLY: nothing in this file clicks, scrolls,
// fetches or navigates. Site markup changes often, so every adapter falls back
// to generic heuristics (links that look like listings, the page <h1>, etc.).
"use strict";
window.JC = window.JC || {};

(() => {
  const text = (el) => (el ? el.innerText || el.textContent || "" : "").replace(/\s+/g, " ").trim();
  const first = (root, selectors) => {
    for (const s of selectors) {
      const el = root.querySelector(s);
      if (el && text(el)) return el;
    }
    return null;
  };
  const longestText = (selectors) => {
    let best = "";
    for (const s of selectors) {
      document.querySelectorAll(s).forEach((el) => {
        const t = (el.innerText || "").trim();
        if (t.length > best.length) best = t;
      });
    }
    return best || null;
  };

  // Shared phrasing for "your application went through".
  const SUCCESS = /(application (was |has been )?(sent|submitted)|successfully applied|applied successfully|you have successfully applied|thank(s| you) for applying|your application is on its way)/i;

  const adapters = {
    linkedin: {
      listingRe: /linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[\w-]*?-)?(\d{6,})/,
      isResults: () => /\/jobs\/(search|collections)/.test(location.pathname),
      isListing: () => /\/jobs\/view\//.test(location.pathname) || /currentJobId=\d+/.test(location.search),
      currentListingUrl: () => {
        const m = location.search.match(/currentJobId=(\d+)/) || location.pathname.match(/jobs\/view\/(?:[\w-]*?-)?(\d+)/);
        return m ? `https://www.linkedin.com/jobs/view/${m[1]}/` : null;
      },
      cards: {
        root: ["li[data-occludable-job-id]", ".job-card-container", ".jobs-search-results__list-item"],
        title: [".job-card-list__title", ".job-card-container__link", "a[href*='/jobs/view/']"],
        company: [".artdeco-entity-lockup__subtitle", ".job-card-container__primary-description", ".job-card-container__company-name"],
        location: [".job-card-container__metadata-item", ".artdeco-entity-lockup__caption"],
      },
      detail: {
        title: [".job-details-jobs-unified-top-card__job-title", ".jobs-unified-top-card__job-title", "h1"],
        company: [".job-details-jobs-unified-top-card__company-name", ".jobs-unified-top-card__company-name"],
        location: [".job-details-jobs-unified-top-card__primary-description-container", ".job-details-jobs-unified-top-card__tertiary-description-container", ".jobs-unified-top-card__bullet"],
        description: ["#job-details", ".jobs-description__content", ".jobs-box__html-content"],
        workMode: [".job-details-preferences-and-skills", ".job-details-jobs-unified-top-card__job-insight"],
      },
      formRoot: () => document.querySelector(".jobs-easy-apply-modal, [data-test-modal-id='easy-apply-modal'], .artdeco-modal[aria-labelledby*='easy-apply' i]"),
      success: SUCCESS,
      loginRe: /linkedin\.com\/(login|uas\/login|authwall|checkpoint\/lg)/,
      challengeRe: /linkedin\.com\/checkpoint\/challenge/,
    },
    internshala: {
      listingRe: /internshala\.com\/((?:internship|job)\/detail\/[\w-]+)/,
      isResults: () => /^\/(internships|jobs)(\/|$)/.test(location.pathname),
      isListing: () => /\/(internship|job)\/detail\//.test(location.pathname),
      currentListingUrl: () => location.href.split(/[?#]/)[0],
      cards: {
        root: [".individual_internship", ".internship_meta", "[internshipid]"],
        title: [".job-internship-name", ".profile a", "h3 a", "a[href*='/detail/']"],
        company: [".company-name", ".company_name", ".company_and_premium p"],
        location: [".locations", ".location_link", ".row-1-item.locations"],
      },
      detail: {
        title: [".profile_on_detail_page", ".heading_4_5.profile", "h1"],
        company: [".company_name a", ".company_name", ".company-name"],
        location: ["#location_names", ".location_link", ".locations"],
        description: [".internship_details", ".text-container", ".detail_view"],
        workMode: [".other_detail_item_row", ".internship_other_details_container"],
      },
      formRoot: () => document.querySelector("#application-form, form#easy_apply_form, .application_form_container, #application_modal, [id*='application'] form"),
      success: SUCCESS,
      loginRe: /internshala\.com\/(login|registration)/,
      challengeRe: /internshala\.com\/.*captcha/i,
    },
    naukri: {
      listingRe: /naukri\.com\/job-listings-[\w-]*?-(\d{9,})/,
      isResults: () => /-jobs(-in-[\w-]+)?(\?|$|-\d+)/.test(location.pathname) || /\/jobs-in-/.test(location.pathname),
      isListing: () => /\/job-listings-/.test(location.pathname),
      currentListingUrl: () => location.href.split(/[?#]/)[0],
      cards: {
        root: [".srp-jobtuple-wrapper", "article.jobTuple", ".cust-job-tuple"],
        title: ["a.title", ".title a"],
        company: ["a.comp-name", ".comp-name", ".subTitle"],
        location: [".locWdth", ".loc-wrap", ".location"],
      },
      detail: {
        title: ["[class*='jd-header-title']", "h1"],
        company: ["[class*='jd-header-comp-name'] a", "[class*='jd-header-comp-name']"],
        location: ["[class*='jhc__location']", "[class*='location']"],
        description: ["[class*='dang-inner-html']", "[class*='job-desc']", "section[class*='JDC']"],
        workMode: ["[class*='wfhmode']", "[class*='work-mode']"],
      },
      formRoot: () => document.querySelector("[class*='chatbot_Drawer'], [class*='chatbot_drawer'], .apply-modal, [role='dialog']"),
      success: SUCCESS,
      loginRe: /naukri\.com\/(nlogin|login)/,
      challengeRe: /naukri\.com\/.*captcha/i,
    },
    unstop: {
      listingRe: /unstop\.com\/((?:jobs|internships|o)\/[\w-]+-\d{5,})/,
      isResults: () => /^\/(jobs|internships)\/?$/.test(location.pathname) || /^\/(job|internship)-portal/.test(location.pathname),
      isListing: () => /^\/(jobs|internships|o)\/[\w-]+-\d{5,}/.test(location.pathname),
      currentListingUrl: () => location.href.split(/[?#]/)[0],
      cards: {
        root: ["app-competition-listing", ".opp_listing", ".single_profile", "[class*='listing'] a[href*='-']"],
        title: ["h2", "h3", ".double-wrap"],
        company: [".cptn p", "[class*='organisation']", "[class*='company']"],
        location: ["[class*='location']"],
      },
      detail: {
        title: ["h1", "h2.title"],
        company: ["[class*='organisation'] a", "[class*='organisation']", "[class*='company']"],
        location: ["[class*='location']"],
        description: ["[class*='about_opp']", "[class*='description']", ".un_editor_text_live", "main"],
        workMode: ["[class*='work_mode']", "[class*='mode']"],
      },
      formRoot: () => document.querySelector("[role='dialog'] form, app-register form, form[class*='register']"),
      success: SUCCESS,
      loginRe: /unstop\.com\/(auth|login)/,
      challengeRe: /unstop\.com\/.*captcha/i,
    },
    wellfound: {
      listingRe: /wellfound\.com\/(?:company\/[\w-]+\/)?jobs\/(\d+)/,
      isResults: () => /^\/(jobs|role|location)/.test(location.pathname) && !/\/jobs\/\d+/.test(location.pathname),
      isListing: () => /\/jobs\/\d+/.test(location.pathname),
      currentListingUrl: () => location.href.split(/[?#]/)[0],
      cards: {
        root: ["[data-test='StartupResult']", "[class*='JobSearchResult']", "div[class*='styles_component'] a[href*='/jobs/']"],
        title: ["a[href*='/jobs/'] span", "a[href*='/jobs/']"],
        company: ["h2", "[class*='company']"],
        location: ["[class*='location']"],
      },
      detail: {
        title: ["h1"],
        company: ["a[href*='/company/'] h2", "a[href*='/company/']"],
        location: ["[class*='location']"],
        description: ["[class*='description']", "[data-test='JobDescription']", "main"],
        workMode: ["[class*='remote']", "[class*='location']"],
      },
      formRoot: () => document.querySelector("[role='dialog'] form, form[class*='apply' i], [data-test='JobApplicationModal']"),
      success: SUCCESS,
      loginRe: /wellfound\.com\/(login|signup)/,
      challengeRe: /wellfound\.com\/.*captcha/i,
    },
  };

  function detect() {
    const h = location.hostname;
    return Object.keys(adapters).find((p) => h === `${p}.com` || h.endsWith(`.${p}.com`) || h === `${p}.in`) || null;
  }

  // Results page: only the cards already rendered in the DOM. No scrolling.
  function extractCards(platform) {
    const a = adapters[platform];
    const out = new Map();
    const add = (url, card, titleEl) => {
      const m = url && url.match(a.listingRe);
      if (!m || out.has(m[1])) return;
      const comp = card ? first(card, a.cards.company) : null;
      const loc = card ? first(card, a.cards.location) : null;
      out.set(m[1], {
        url,
        title: text(titleEl) || null,
        company: comp ? text(comp).split(/\s[·•|]\s/)[0] : null,
        location: loc ? text(loc) : null,
        source: "results_page",
      });
    };
    for (const sel of a.cards.root) {
      document.querySelectorAll(sel).forEach((card) => {
        const link = card.matches("a") ? card : card.querySelector("a[href]");
        const dataHref = card.getAttribute("data-href");
        const url = dataHref ? new URL(dataHref, location.origin).href : link && link.href;
        add(url, card, first(card, a.cards.title) || link);
      });
    }
    // Fallback: any visible link that looks like a listing.
    document.querySelectorAll("a[href]").forEach((link) => {
      if (link.offsetParent === null) return;
      const card = link.closest("li, article, [class*='card' i], [class*='tuple' i]");
      add(link.href, card, link);
    });
    // On LinkedIn the selected job is shown beside the list: grab it too.
    if (platform === "linkedin" && a.isListing()) {
      const d = extractListing(platform);
      if (d) out.set("current", { ...d, source: "listing_page" });
    }
    return [...out.values()];
  }

  function extractListing(platform) {
    const a = adapters[platform];
    const url = a.currentListingUrl();
    if (!url || !a.listingRe.test(url)) return null;
    const t = first(document, a.detail.title);
    const c = first(document, a.detail.company);
    const l = first(document, a.detail.location);
    const w = first(document, a.detail.workMode);
    return {
      url,
      title: text(t) || null,
      company: c ? text(c).split(/\s[·•|]\s/)[0] : null,
      location: l ? text(l).slice(0, 200) : null,
      work_mode: w ? text(w).slice(0, 200) : null,
      description: (longestText(a.detail.description) || "").slice(0, 20000) || null,
      source: "listing_page",
    };
  }

  JC.platforms = { adapters, detect, extractCards, extractListing, text };
})();
