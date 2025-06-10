import api from "../../services/api";
import toastError from "../../errors/toastError";
import { useState, useEffect } from "react";
import { toast } from "react-toastify";
import { i18n } from "../../translate/i18n";

const useUser = () => {
  const [users, setUsers] = useState([]);
  const [update, setUpdate] = useState(true);

  useEffect(() => {
    (async () => {
      if (update) {
        try {
          const { data } = await api.get("/users");
          setUsers(data.users);
          setUpdate(false);
        } catch (err) {
          if (err.response?.status !== 500) {
            toastError(err);
          } else {
            toast.error(`${i18n.t("frontEndErrors.getUsers")}`);
          }
        }
      }
    })();
  });

  return { users };
};

export default useUser;
