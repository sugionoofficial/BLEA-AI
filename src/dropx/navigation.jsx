// DropX Admin navigation — replicated exactly from the official template
// (config/navigation.ts). Icons use lucide-react like the template.
import {
  AlertCircle,
  AlertTriangle,
  AlignCenter,
  AlignVerticalJustifyCenter,
  ArrowDownUp,
  BarChart3,
  Bell,
  BookOpen,
  Briefcase,
  Calendar,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Cloud,
  Columns2,
  Columns3,
  Cookie,
  CreditCard,
  Eye,
  FileText,
  FoldVertical,
  FormInput,
  GitCommit,
  GraduationCap,
  Grid3x3,
  Hash,
  Headphones,
  HelpCircle,
  Image,
  Images,
  Info,
  LayoutDashboard,
  LifeBuoy,
  Link,
  Link2,
  List,
  ListTree,
  Loader,
  Lock,
  Mail,
  Map,
  Maximize2,
  MessageCircle,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  MousePointer2,
  Move,
  Paintbrush,
  Palette,
  PanelLeft,
  PanelRight,
  PanelTop,
  PieChart,
  Puzzle,
  RectangleHorizontal,
  Rocket,
  RotateCw,
  Rows2,
  Ruler,
  ScanSearch,
  Search,
  Share2,
  ShoppingBag,
  ShoppingCart,
  Smile,
  Space,
  Sparkles,
  Square,
  Table,
  Tag,
  TextCursorInput,
  Type,
  User,
  Users,
  Video,
} from 'lucide-react';

export const navigation = [
  {
    label: 'Dashboard',
    items: [
      { title: 'Default', href: '/dashboard', icon: LayoutDashboard },
      { title: 'Analytics', href: '/dashboard/analytics', icon: BarChart3 },
      { title: 'CRM', href: '/dashboard/crm', icon: Users },
      { title: 'E-commerce', href: '/dashboard/ecommerce', icon: ShoppingBag },
      { title: 'LMS', href: '/dashboard/lms', icon: GraduationCap },
      { title: 'Management', href: '/dashboard/management', icon: Briefcase },
      { title: 'SaaS', href: '/dashboard/saas', icon: Cloud },
      { title: 'Support Desk', href: '/dashboard/support-desk', icon: Headphones },
    ],
  },
  {
    label: 'Application',
    items: [
      { title: 'Calendar', href: '/app/calendar', icon: Calendar },
      { title: 'Chat', href: '/app/chat', icon: MessageSquare },
      {
        title: 'Email',
        href: '/app/email',
        icon: Mail,
        children: [
          { title: 'Inbox', href: '/app/email/inbox' },
          { title: 'Email Detail', href: '/app/email/detail' },
          { title: 'Compose', href: '/app/email/compose' },
        ],
      },
      {
        title: 'Events',
        href: '/app/events',
        icon: CalendarDays,
        children: [
          { title: 'Create an Event', href: '/app/events/create' },
          { title: 'Event Detail', href: '/app/events/detail' },
          { title: 'Event List', href: '/app/events/list' },
        ],
      },
      {
        title: 'E-commerce',
        href: '/app/ecommerce',
        icon: ShoppingCart,
        children: [
          { title: 'Product List', href: '/app/ecommerce/products' },
          { title: 'Product Grid', href: '/app/ecommerce/products/grid' },
          { title: 'Product Details', href: '/app/ecommerce/products/details' },
          { title: 'Add Product', href: '/app/ecommerce/products/new' },
          { title: 'Order List', href: '/app/ecommerce/orders' },
          { title: 'Order Details', href: '/app/ecommerce/orders/details' },
          { title: 'Customers', href: '/app/ecommerce/customers' },
          { title: 'Customer Details', href: '/app/ecommerce/customers/details' },
          { title: 'Shopping Cart', href: '/app/ecommerce/cart' },
          { title: 'Checkout', href: '/app/ecommerce/checkout' },
          { title: 'Billing', href: '/app/ecommerce/billing' },
          { title: 'Invoice', href: '/app/ecommerce/invoice' },
        ],
      },
      {
        title: 'E-learning',
        href: '/app/e-learning',
        icon: BookOpen,
        children: [
          { title: 'Course', href: '/app/e-learning/course' },
          { title: 'Student Overview', href: '/app/e-learning/student-overview' },
          { title: 'Trainer Profile', href: '/app/e-learning/trainer-profile' },
        ],
      },
      { title: 'Kanban', href: '/app/kanban', icon: Columns3 },
      {
        title: 'Social',
        href: '/app/social',
        icon: Share2,
        children: [
          { title: 'Feed', href: '/app/social/feed' },
          { title: 'Activity Log', href: '/app/social/activity-log' },
          { title: 'Notifications', href: '/app/social/notifications' },
          { title: 'Followers', href: '/app/social/followers' },
        ],
      },
      {
        title: 'Support Desk',
        href: '/app/support-desk',
        icon: LifeBuoy,
        children: [
          { title: 'Table View', href: '/app/support-desk/table' },
          { title: 'Card View', href: '/app/support-desk/cards' },
          { title: 'Contacts', href: '/app/support-desk/contacts' },
          { title: 'Contact Detail', href: '/app/support-desk/contacts/detail' },
          { title: 'Tickets Preview', href: '/app/support-desk/tickets' },
          { title: 'Quick Links', href: '/app/support-desk/quick-links' },
          { title: 'Reports', href: '/app/support-desk/reports' },
        ],
      },
    ],
  },
  {
    label: 'Layouts',
    items: [
      { title: 'Navbar Vertical', href: '/layouts/navbar-vertical', icon: PanelLeft },
      { title: 'Top Nav', href: '/layouts/top-nav', icon: PanelTop },
      { title: 'Double Top', href: '/layouts/double-top', icon: Rows2 },
      { title: 'Combo Nav', href: '/layouts/combo-nav', icon: Columns2 },
    ],
  },
  {
    label: 'Pages',
    items: [
      { title: 'Starter', href: '/pages/starter', icon: FileText },
      { title: 'Landing', href: '/pages/landing', icon: Rocket },
      {
        title: 'Authentication',
        href: '/auth',
        icon: Lock,
        children: [
          { title: 'Simple Login', href: '/auth/simple/login' },
          { title: 'Simple Register', href: '/auth/simple/register' },
          { title: 'Simple Forgot Password', href: '/auth/simple/forgot-password' },
          { title: 'Simple Confirm Mail', href: '/auth/simple/confirm-mail' },
          { title: 'Simple Reset Password', href: '/auth/simple/reset-password' },
          { title: 'Simple Lock Screen', href: '/auth/simple/lock-screen' },
          { title: 'Card Login', href: '/auth/card/login' },
          { title: 'Card Register', href: '/auth/card/register' },
          { title: 'Card Forgot Password', href: '/auth/card/forgot-password' },
          { title: 'Card Confirm Mail', href: '/auth/card/confirm-mail' },
          { title: 'Card Reset Password', href: '/auth/card/reset-password' },
          { title: 'Card Lock Screen', href: '/auth/card/lock-screen' },
          { title: 'Split Login', href: '/auth/split/login' },
          { title: 'Split Register', href: '/auth/split/register' },
          { title: 'Split Forgot Password', href: '/auth/split/forgot-password' },
          { title: 'Split Confirm Mail', href: '/auth/split/confirm-mail' },
          { title: 'Split Reset Password', href: '/auth/split/reset-password' },
          { title: 'Split Lock Screen', href: '/auth/split/lock-screen' },
        ],
      },
      {
        title: 'User',
        href: '/pages/user',
        icon: User,
        children: [
          { title: 'Profile', href: '/pages/user/profile' },
          { title: 'Settings', href: '/pages/user/settings' },
        ],
      },
      {
        title: 'Pricing',
        href: '/pages/pricing',
        icon: CreditCard,
        children: [
          { title: 'Pricing Default', href: '/pages/pricing' },
          { title: 'Pricing Alt', href: '/pages/pricing/alt' },
        ],
      },
      {
        title: 'FAQ',
        href: '/pages/faq',
        icon: HelpCircle,
        children: [
          { title: 'FAQ Basic', href: '/pages/faq' },
          { title: 'FAQ Alt', href: '/pages/faq/alt' },
          { title: 'FAQ Accordion', href: '/pages/faq/accordion' },
        ],
      },
      {
        title: 'Errors',
        href: '/errors',
        icon: AlertTriangle,
        children: [
          { title: '404', href: '/errors/404' },
          { title: '500', href: '/errors/500' },
        ],
      },
      {
        title: 'Miscellaneous',
        href: '/pages/misc',
        icon: Puzzle,
        children: [
          { title: 'Associations', href: '/pages/misc/associations' },
          { title: 'Invite People', href: '/pages/misc/invite' },
          { title: 'Privacy Policy', href: '/pages/misc/privacy-policy' },
        ],
      },
    ],
  },
  {
    label: 'Modules',
    items: [
      {
        title: 'Forms',
        href: '/modules/forms',
        icon: FormInput,
        children: [
          { title: 'Basic', href: '/modules/forms/basic' },
          { title: 'Advance', href: '/modules/forms/advance' },
          { title: 'Floating Labels', href: '/modules/forms/floating-labels' },
          { title: 'Wizard', href: '/modules/forms/wizard' },
          { title: 'Validation', href: '/modules/forms/validation' },
        ],
      },
      {
        title: 'Tables',
        href: '/modules/tables',
        icon: Table,
        children: [
          { title: 'Basic Tables', href: '/modules/tables/basic' },
          { title: 'Advance Tables', href: '/modules/tables/advance' },
          { title: 'Bulk Select', href: '/modules/tables/bulk-select' },
        ],
      },
      { title: 'Charts', href: '/modules/charts/recharts', icon: PieChart },
      {
        title: 'Icons',
        href: '/modules/icons',
        icon: Smile,
        children: [
          { title: 'Font Awesome', href: '/modules/icons/font-awesome' },
          { title: 'Bootstrap Icons', href: '/modules/icons/bootstrap' },
          { title: 'Feather', href: '/modules/icons/feather' },
          { title: 'Material Icons', href: '/modules/icons/material' },
        ],
      },
      { title: 'Maps', href: '/modules/maps', icon: Map },
    ],
  },
  {
    label: 'Components',
    items: [
      { title: 'Accordion', href: '/components/accordion', icon: ChevronsUpDown },
      { title: 'Alerts', href: '/components/alerts', icon: AlertCircle },
      { title: 'Animated Icons', href: '/components/animated-icons', icon: Sparkles },
      { title: 'Badges', href: '/components/badges', icon: Tag },
      { title: 'Breadcrumbs', href: '/components/breadcrumbs', icon: ChevronRight },
      { title: 'Buttons', href: '/components/buttons', icon: MousePointer2 },
      { title: 'Cards', href: '/components/cards', icon: Square },
      { title: 'Carousel', href: '/components/carousel', icon: Image },
      { title: 'Collapse', href: '/components/collapse', icon: FoldVertical },
      { title: 'Cookie Notice', href: '/components/cookie-notice', icon: Cookie },
      { title: 'CountUp', href: '/components/countup', icon: Hash },
      { title: 'Dropdowns', href: '/components/dropdowns', icon: ChevronDown },
      { title: 'List Group', href: '/components/list-group', icon: List },
      { title: 'Modals', href: '/components/modals', icon: Maximize2 },
      {
        title: 'Navs & Tabs',
        href: '/components/navs-tabs',
        icon: PanelTop,
        children: [
          { title: 'Navs', href: '/components/navs-tabs/navs' },
          { title: 'Navbar', href: '/components/navs-tabs/navbar' },
          { title: 'Tabs', href: '/components/navs-tabs/tabs' },
        ],
      },
      { title: 'Offcanvas', href: '/components/offcanvas', icon: PanelRight },
      { title: 'Pagination', href: '/components/pagination', icon: MoreHorizontal },
      {
        title: 'Pictures',
        href: '/components/pictures',
        icon: Images,
        children: [
          { title: 'Avatars', href: '/components/pictures/avatars' },
          { title: 'Images', href: '/components/pictures/images' },
          { title: 'Figures', href: '/components/pictures/figures' },
          { title: 'Hoverbox', href: '/components/pictures/hoverbox' },
          { title: 'Lightbox', href: '/components/pictures/lightbox' },
        ],
      },
      { title: 'Placeholder', href: '/components/placeholder', icon: RectangleHorizontal },
      { title: 'Popovers', href: '/components/popovers', icon: MessageCircle },
      { title: 'Progress Bar', href: '/components/progress-bar', icon: Loader },
      { title: 'Scrollspy', href: '/components/scrollspy', icon: ScanSearch },
      { title: 'Search', href: '/components/search', icon: Search },
      { title: 'Sortable', href: '/components/sortable', icon: ArrowDownUp },
      { title: 'Spinners', href: '/components/spinners', icon: RotateCw },
      { title: 'Timeline', href: '/components/timeline', icon: GitCommit },
      { title: 'Toasts', href: '/components/toasts', icon: Bell },
      { title: 'Tooltips', href: '/components/tooltips', icon: Info },
      { title: 'Treeview', href: '/components/treeview', icon: ListTree },
      { title: 'Typed Text', href: '/components/typed-text', icon: TextCursorInput },
      {
        title: 'Videos',
        href: '/components/videos',
        icon: Video,
        children: [
          { title: 'Embed', href: '/components/videos/embed' },
          { title: 'Plyr', href: '/components/videos/plyr' },
        ],
      },
    ],
  },
  {
    label: 'Utilities',
    items: [
      { title: 'Background', href: '/utilities/background', icon: Paintbrush },
      { title: 'Borders', href: '/utilities/borders', icon: Square },
      { title: 'Colored Links', href: '/utilities/colored-links', icon: Link },
      { title: 'Colors', href: '/utilities/colors', icon: Palette },
      { title: 'Display', href: '/utilities/display', icon: Monitor },
      { title: 'Flex', href: '/utilities/flex', icon: AlignCenter },
      { title: 'Float', href: '/utilities/float', icon: Move },
      { title: 'Grid', href: '/utilities/grid', icon: Grid3x3 },
      { title: 'Sizing', href: '/utilities/sizing', icon: Ruler },
      { title: 'Spacing', href: '/utilities/spacing', icon: Space },
      { title: 'Stretched Link', href: '/utilities/stretched-link', icon: Link2 },
      { title: 'Typography', href: '/utilities/typography', icon: Type },
      { title: 'Vertical Align', href: '/utilities/vertical-align', icon: AlignVerticalJustifyCenter },
      { title: 'Visibility', href: '/utilities/visibility', icon: Eye },
    ],
  },
];

// Map template routes to the BLEA-AI app routes. The template's demo pages
// don't exist here, so every item resolves to a real BLEA route; a few map
// to their closest BLEA equivalent (projects/settings/landing/login).
const routeMap = {
  '/dashboard': '/app',
  '/dashboard/analytics': '/app',
  '/dashboard/crm': '/app',
  '/dashboard/ecommerce': '/app',
  '/dashboard/lms': '/app',
  '/dashboard/management': '/projects',
  '/dashboard/saas': '/app',
  '/dashboard/support-desk': '/app',
  '/app/calendar': '/app',
  '/app/chat': '/app',
  '/app/email': '/app',
  '/app/events': '/app',
  '/app/ecommerce': '/projects',
  '/app/e-learning': '/app',
  '/app/kanban': '/projects',
  '/app/social': '/app',
  '/app/support-desk': '/app',
  '/pages/starter': '/app',
  '/pages/landing': '/',
  '/pages/user': '/settings',
  '/pages/user/profile': '/settings',
  '/pages/user/settings': '/settings',
  '/pages/pricing': '/',
  '/pages/faq': '/',
  '/pages/misc': '/app',
  '/auth': '/login',
};

export function resolveRoute(href) {
  if (routeMap[href]) return routeMap[href];
  // /app/*, /layouts/*, /errors/*, /modules/*, /components/*, /utilities/*,
  // /pages/*, /auth/* — keep the template's grouping but land in-app.
  const prefix = href.split('/').slice(0, 2).join('/');
  if (prefix === '/auth') return '/login';
  if (href.startsWith('/pages/user')) return '/settings';
  if (href.startsWith('/pages/landing') || href.startsWith('/pages/pricing') || href.startsWith('/pages/faq')) return '/';
  return '/app';
}

// First nav item (document order) whose resolved route matches the current
// path wins the active highlight — same behaviour as the template where each
// section highlights its own entry.
export function activeNavHref(pathname) {
  for (const group of navigation) {
    for (const item of group.items) {
      const children = item.children ?? [];
      if (children.some((child) => resolveRoute(child.href) === pathname)) {
        return item.href;
      }
      if (resolveRoute(item.href) === pathname) {
        return item.href;
      }
    }
  }
  return null;
}
